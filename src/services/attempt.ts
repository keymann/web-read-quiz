import * as assignmentsRepo from "../repositories/assignments";
import * as attemptsRepo from "../repositories/attempts";
import * as questionsRepo from "../repositories/questions";
import * as quizzesRepo from "../repositories/quizzes";
import type { AppEnv } from "../types";
import { conflict, forbidden, invalid, notFound } from "../utils/response";

/**
 * 아이가 퀴즈를 푸는 판(Attempt) — §15·§17·§22.
 *
 * 규칙 세 가지가 이 파일의 전부다.
 *  1. 시작할 때 문항을 **버전으로 고정한다.** 푸는 도중 부모가 문제를 고쳐도 판은 안 흔들린다.
 *  2. 한 문제는 한 번만 답한다. 되돌아가 볼 수는 있어도 다시 답할 수는 없다.
 *  3. 통과 기준만큼 맞히면 **그 자리에서 끝낸다.** 남은 문항은 미응답으로 남는다.
 */

/**
 * 점수 = 통과 기준 대비 진척도(§17).
 *
 * 문항 수 대비 백분율이 아니다. 요구사항의 예시가 "20문항 중 10개 정답 → 100점,
 * 8개 정답 → 80점" 이라 통과 기준을 100점으로 환산한 것이고, 부모가 문항 수를 바꿔도
 * 같은 의미가 유지된다.
 */
export const scoreOf = (correctCount: number, passCount: number): number =>
	Math.min(100, Math.round((correctCount / Math.max(1, passCount)) * 100));

export interface QuestionView {
	questionNumber: number;
	questionText: string;
	choices: string[];
	/** 답한 문항만 채워진다. 아직 안 푼 문항에는 정답이 실리지 않는다. */
	selectedChoice: number | null;
	correctChoice: number | null;
	isCorrect: boolean | null;
	explanation: string | null;
}

export interface AttemptView {
	id: string;
	quizId: string;
	bookTitle: string;
	round: number;
	attemptNo: number;
	total: number;
	passCount: number;
	answered: number;
	correctCount: number;
	wrongCount: number;
	score: number;
	passed: boolean;
	completedAt: string | null;
	/** 다음에 풀 문항 번호. 다 풀었거나 끝난 판이면 null. */
	nextNumber: number | null;
	questions: QuestionView[];
}

/**
 * 아직 답하지 않은 문항에서는 **정답을 빼고** 내려준다.
 *
 * 응답에 담기만 해도 개발자 도구로 볼 수 있다. 채점은 서버가 하므로 클라이언트가 정답을
 * 알아야 할 이유가 없고, 답한 뒤에는(§15 즉시 채점) 그때 담아 주면 된다.
 */
function toQuestionView(row: attemptsRepo.AttemptQuestionRow): QuestionView {
	const answered = row.selected_choice !== null;

	return {
		questionNumber: row.question_number,
		questionText: row.question_text,
		choices: [row.choice1, row.choice2, row.choice3, row.choice4],
		selectedChoice: row.selected_choice,
		correctChoice: answered ? row.correct_choice : null,
		isCorrect: answered ? row.is_correct === 1 : null,
		explanation: answered ? row.explanation : null,
	};
}

async function view(env: AppEnv, attemptId: string): Promise<AttemptView> {
	const summary = await attemptsRepo.findSummary(env, attemptId);
	if (!summary) throw notFound("퀴즈를 찾을 수 없습니다.");

	const rows = await attemptsRepo.listQuestions(env, attemptId);
	const questions = rows.map(toQuestionView);
	const unanswered = rows.find((r) => r.selected_choice === null);

	return {
		id: summary.id,
		quizId: summary.quiz_id,
		bookTitle: summary.book_title,
		round: summary.quiz_round,
		attemptNo: summary.attempt_no,
		total: rows.length,
		passCount: summary.pass_count,
		answered: rows.filter((r) => r.selected_choice !== null).length,
		correctCount: summary.correct_count,
		wrongCount: summary.wrong_count,
		score: summary.completed_at
			? summary.score
			: scoreOf(summary.correct_count, summary.pass_count),
		passed: summary.passed === 1,
		completedAt: summary.completed_at,
		nextNumber: summary.completed_at ? null : (unanswered?.question_number ?? null),
		questions,
	};
}

/* ── 시작 ────────────────────────────────────────────── */

/**
 * 배정을 받아 판을 연다.
 *
 * 이미 풀던 판이 있으면 그것을 이어 준다. 새로 시작하면 앞서 답한 것이 사라진 것처럼 보이고,
 * 실제로는 남아 있어 이력에 두 판이 겹쳐 쌓인다.
 */
export async function start(
	env: AppEnv,
	childId: string,
	assignmentId: string,
): Promise<AttemptView> {
	const assignment = await env.DB.prepare("SELECT * FROM quiz_assignments WHERE id = ?")
		.bind(assignmentId)
		.first<assignmentsRepo.AssignmentRow>();

	if (!assignment) throw notFound("퀴즈를 찾을 수 없습니다.");
	// 남의 배정 id 를 넣어도 존재 여부조차 알려주지 않는다(§21.5).
	if (assignment.child_id !== childId) throw forbidden("내 퀴즈가 아닙니다.");
	if (assignment.status === "COMPLETED") throw conflict("이미 다 푼 퀴즈입니다.");

	const open = await attemptsRepo.findOpenForAssignment(env, assignmentId);
	if (open) return view(env, open.id);

	const quiz = await quizzesRepo.find(env, assignment.quiz_id);
	if (!quiz) throw notFound("퀴즈를 찾을 수 없습니다.");

	// 시작 시점의 활성 문항을 그대로 고정한다. 이후 부모가 무엇을 하든 이 판은 안 바뀐다(§22).
	const active = await questionsRepo.listActive(env, quiz.id);
	if (active.length === 0) throw invalid("아직 문제가 준비되지 않았습니다.");

	const versions = await questionsRepo.currentVersionIds(
		env,
		active.map((q) => q.id),
	);

	const attemptId = await attemptsRepo.start(env, {
		assignmentId,
		quizId: quiz.id,
		childId,
		attemptNo: (await attemptsRepo.countForAssignment(env, assignmentId)) + 1,
		questions: active.map((q) => ({
			questionId: q.id,
			versionId: versions.get(q.id)!,
			questionNumber: q.question_number,
		})),
	});

	return view(env, attemptId);
}

export async function detail(
	env: AppEnv,
	childId: string,
	attemptId: string,
): Promise<AttemptView> {
	const row = await attemptsRepo.findOwned(env, childId, attemptId);
	if (!row) throw notFound("퀴즈를 찾을 수 없습니다.");
	return view(env, attemptId);
}

/* ── 답하기 ──────────────────────────────────────────── */

export interface AnswerResult {
	isCorrect: boolean;
	correctChoice: number;
	explanation: string | null;
	/** 이 답으로 판이 끝났는지. 통과 기준을 채웠거나 마지막 문항이었을 때. */
	finished: boolean;
	attempt: AttemptView;
}

/**
 * 답을 채점하고 기록한다.
 *
 * **정답은 클라이언트가 보낸 값을 쓰지 않는다.** 아이가 고른 번호만 받고, 맞고 틀림은
 * 고정된 버전의 `correct_choice` 로 서버가 판정한다.
 */
export async function answer(
	env: AppEnv,
	childId: string,
	attemptId: string,
	questionNumber: number,
	selectedChoice: number,
): Promise<AnswerResult> {
	const attempt = await attemptsRepo.findOwned(env, childId, attemptId);
	if (!attempt) throw notFound("퀴즈를 찾을 수 없습니다.");
	if (attempt.completed_at) throw conflict("이미 끝난 퀴즈입니다.");

	if (!Number.isInteger(selectedChoice) || selectedChoice < 1 || selectedChoice > 4) {
		throw invalid("답은 1~4 중에서 고릅니다.");
	}

	const rows = await attemptsRepo.listQuestions(env, attemptId);
	const target = rows.find((r) => r.question_number === questionNumber);
	if (!target) throw notFound("문제를 찾을 수 없습니다.");
	// 되돌아가 볼 수는 있어도 다시 답할 수는 없다(§15). DB 유니크 인덱스도 같은 것을 막는다.
	if (target.selected_choice !== null) throw conflict("이미 답한 문제입니다.");

	const isCorrect = selectedChoice === target.correct_choice;
	await attemptsRepo.recordAnswer(env, {
		attemptId,
		questionId: target.question_id,
		questionVersionId: target.question_version_id,
		selectedChoice,
		correctChoice: target.correct_choice,
		isCorrect,
	});

	const summary = await attemptsRepo.findSummary(env, attemptId);
	const correctCount = summary?.correct_count ?? 0;
	const answered = rows.filter((r) => r.selected_choice !== null).length + 1;

	// 통과 기준을 채우면 그 자리에서 끝낸다(§15). 남은 문항은 미응답으로 남는다.
	const passed = correctCount >= (summary?.pass_count ?? 0);
	const finished = passed || answered >= rows.length;

	if (finished) {
		await attemptsRepo.complete(env, attemptId, {
			score: scoreOf(correctCount, summary?.pass_count ?? 1),
			passed,
		});
	}

	return {
		isCorrect,
		correctChoice: target.correct_choice,
		explanation: target.explanation,
		finished,
		attempt: await view(env, attemptId),
	};
}

/**
 * 아이가 스스로 그만둔다. 남은 문항은 미응답으로 두고 지금까지의 결과로 확정한다.
 *
 * 끝내지 않고 나가면 배정이 영영 "푸는 중" 으로 남아 다시 시작할 수도, 재도전할 수도 없다.
 */
export async function submit(
	env: AppEnv,
	childId: string,
	attemptId: string,
): Promise<AttemptView> {
	const attempt = await attemptsRepo.findOwned(env, childId, attemptId);
	if (!attempt) throw notFound("퀴즈를 찾을 수 없습니다.");

	if (!attempt.completed_at) {
		const summary = await attemptsRepo.findSummary(env, attemptId);
		const correctCount = summary?.correct_count ?? 0;
		await attemptsRepo.complete(env, attemptId, {
			score: scoreOf(correctCount, summary?.pass_count ?? 1),
			passed: correctCount >= (summary?.pass_count ?? 0),
		});
	}

	return view(env, attemptId);
}

/* ── 지난 기록 ───────────────────────────────────────── */

export interface AttemptSummaryView {
	id: string;
	bookTitle: string;
	round: number;
	attemptNo: number;
	total: number;
	passCount: number;
	correctCount: number;
	score: number;
	passed: boolean;
	completedAt: string | null;
	startedAt: string;
}

export async function history(
	env: AppEnv,
	childId: string,
): Promise<AttemptSummaryView[]> {
	const rows = await attemptsRepo.listForChild(env, childId);
	return rows.map((row) => ({
		id: row.id,
		bookTitle: row.book_title,
		round: row.quiz_round,
		attemptNo: row.attempt_no,
		total: row.question_count,
		passCount: row.pass_count,
		correctCount: row.correct_count,
		score: row.score,
		passed: row.passed === 1,
		completedAt: row.completed_at,
		startedAt: row.started_at,
	}));
}
