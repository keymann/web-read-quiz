import * as assignmentsRepo from "../repositories/assignments";
import * as attemptsRepo from "../repositories/attempts";
import * as booksRepo from "../repositories/books";
import * as questionsRepo from "../repositories/questions";
import * as quizzesRepo from "../repositories/quizzes";
import * as settingsRepo from "../repositories/settings";
import type { AppEnv } from "../types";
import { newId } from "../utils/id";
import { conflict, invalid, notFound } from "../utils/response";

/**
 * 재도전(§18).
 *
 * 통과하지 못하면 **20분 뒤에** 다시 도전할 수 있고, 그때는 **새 문제**로 푼다. 같은 문제를
 * 다시 주면 답을 외워서 통과할 수 있어 "책을 읽었는지 확인한다" 는 목적이 무너진다.
 *
 *   실패한 판 → 20분 대기 → 같은 책의 round+1 퀴즈 생성 → 새 배정 → 새 판
 *
 * 기존 Quiz·Attempt 는 건드리지 않는다. 지난 판의 문항과 답은 그대로 남아 조회된다(§22).
 */

/** 쿨다운. 바로 다시 풀면 책을 읽지 않고 기억으로 맞히게 된다(§18). */
export const COOLDOWN_MS = 20 * 60 * 1000;

/**
 * 재도전이 지금 어떤 상태인지.
 *
 * - `PASSED`      통과했다. 재도전할 이유가 없다
 * - `COOLDOWN`    아직 기다려야 한다
 * - `READY`       지금 새 문제를 만들 수 있다
 * - `PREPARING`   새 판이 만들어졌고 문제를 만드는 중이다
 * - `NEEDS_PARENT` 새 판은 만들어졌지만 문제는 부모가 만들어 줘야 한다
 * - `FAILED`      만들려다 실패했다. 기다려도 저절로 되지 않는다
 * - `WAITING`     새 판의 문제가 준비되어 풀 수 있다
 */
export type RetryStatus =
	| "PASSED"
	| "COOLDOWN"
	| "READY"
	| "PREPARING"
	| "NEEDS_PARENT"
	| "FAILED"
	| "WAITING";

export interface RetryState {
	status: RetryStatus;
	/** 남은 대기 시간(초). 화면의 카운트다운은 이 값에서 시작한다. */
	waitSeconds: number;
	/** 언제부터 가능한지. 표시용이며 판정은 서버가 한다. */
	availableAt: string | null;
	/** 이미 만들어 둔 다음 판. 문제가 준비되면 이걸로 시작한다. */
	nextAssignmentId: string | null;
	/** 다음 판의 문항이 몇 개 준비됐는지. `PREPARING` 동안 진행을 보여준다. */
	prepared: number;
	total: number;
	/** `FAILED` 일 때 서버가 남긴 사유. 부모에게 그대로 보여준다. */
	error: string | null;
}

/**
 * 서버가 이 부모의 AI 를 대신 부를 수 있는지.
 *
 * Gemini 는 요청을 보낸 서버의 위치를 보고 막아서 배포 환경에서는 부를 수 없다
 * (`services/settings.ts` 의 같은 판단). 그 경우 문제 생성은 **부모의 브라우저**가 해야 하므로
 * 아이가 재도전을 눌러도 서버가 바로 만들어 줄 수 없다.
 */
async function serverCanGenerate(env: AppEnv, parentUserId: string): Promise<boolean> {
	const row = await settingsRepo.find(env, parentUserId);
	return row?.ai_provider !== "gemini";
}

/** 이 아이가 이 책으로 아직 안 끝낸 배정. 재도전을 두 번 만들지 않기 위해 본다. */
async function findPendingNext(
	env: AppEnv,
	childId: string,
	bookId: string,
	excludeQuizId: string,
): Promise<{ assignmentId: string; quizId: string } | null> {
	const row = await env.DB.prepare(
		`SELECT a.id AS assignment_id, a.quiz_id
		   FROM quiz_assignments a
		   JOIN quizzes z ON z.id = a.quiz_id
		  WHERE a.child_id = ? AND z.book_id = ? AND a.quiz_id <> ? AND a.status <> 'COMPLETED'
		  ORDER BY z.round DESC
		  LIMIT 1`,
	)
		.bind(childId, bookId, excludeQuizId)
		.first<{ assignment_id: string; quiz_id: string }>();

	return row ? { assignmentId: row.assignment_id, quizId: row.quiz_id } : null;
}

/**
 * 이 판을 기준으로 재도전이 어떤 상태인지 알려준다.
 *
 * 대기 시간은 **서버가** 마지막 판의 `completed_at` 으로 계산한다. 클라이언트 타이머는
 * 표시용이라 기기 시계를 돌려도 소용없다.
 */
export async function state(
	env: AppEnv,
	childId: string,
	attemptId: string,
	now = Date.now(),
): Promise<RetryState> {
	const attempt = await attemptsRepo.findSummary(env, attemptId);
	if (!attempt || attempt.child_id !== childId) throw notFound("퀴즈를 찾을 수 없습니다.");

	const idle: RetryState = {
		status: "PASSED",
		waitSeconds: 0,
		availableAt: null,
		nextAssignmentId: null,
		prepared: 0,
		total: 0,
		error: null,
	};

	if (attempt.passed === 1) return idle;
	// 아직 풀고 있는 판은 재도전을 따질 단계가 아니다.
	if (!attempt.completed_at) return { ...idle, status: "COOLDOWN" };

	const quiz = await quizzesRepo.find(env, attempt.quiz_id);
	if (!quiz) throw notFound("퀴즈를 찾을 수 없습니다.");

	// 이미 다음 판을 만들어 뒀다면 그 준비 상태를 보여준다. 대기 시간은 이미 지난 뒤다.
	const pending = await findPendingNext(env, childId, quiz.book_id, quiz.id);
	if (pending) {
		const next = await quizzesRepo.find(env, pending.quizId);
		const prepared = await questionsRepo.countActive(env, pending.quizId);
		const total = next?.question_count ?? 0;

		return {
			status: await pendingStatus(env, quiz, next, prepared, total),
			waitSeconds: 0,
			availableAt: null,
			nextAssignmentId: pending.assignmentId,
			prepared,
			total,
			error: next?.generation_error ?? null,
		};
	}

	const availableAtMs = new Date(attempt.completed_at).getTime() + COOLDOWN_MS;
	const waitMs = availableAtMs - now;

	return {
		status: waitMs > 0 ? "COOLDOWN" : "READY",
		waitSeconds: Math.max(0, Math.ceil(waitMs / 1000)),
		availableAt: new Date(availableAtMs).toISOString(),
		nextAssignmentId: null,
		prepared: 0,
		total: 0,
		error: null,
	};
}

/**
 * 만들어 둔 다음 판이 지금 어떤 상태인지.
 *
 * 문항이 다 찼으면 풀 수 있고, 아직이면 만드는 중이다 — 여기까지는 단순하다. 문제는
 * **실패한 경우**다. 서버가 만들다 실패해도(크레딧 부족·키 만료 등) 문항 수는 그대로 0이라
 * 아이 화면은 "만들고 있어요" 를 영원히 띄운다. 실제로 배포 환경에서 그렇게 보였다.
 *
 * 그래서 퀴즈에 남은 실패 사유를 함께 본다. 기다려도 저절로 되지 않는 상태와 곧 될 상태는
 * 아이에게 다른 말을 해줘야 한다.
 */
async function pendingStatus(
	env: AppEnv,
	quiz: quizzesRepo.QuizRow,
	next: quizzesRepo.QuizRow | null,
	prepared: number,
	total: number,
): Promise<RetryStatus> {
	if (total > 0 && prepared >= total) return "WAITING";

	// 만들다 멈췄다. 부모가 손을 대야 한다.
	if (next?.generation_error && next.status !== "GENERATING") return "FAILED";

	return (await serverCanGenerate(env, quiz.parent_user_id)) ? "PREPARING" : "NEEDS_PARENT";
}

/** 이 퀴즈를 만든 부모. 생성은 부모의 AI 설정으로 돌아야 한다. */
export async function parentOf(env: AppEnv, quizId: string): Promise<string> {
	const quiz = await quizzesRepo.find(env, quizId);
	if (!quiz) throw notFound("퀴즈를 찾을 수 없습니다.");
	return quiz.parent_user_id;
}

export interface RetryResult {
	state: RetryState;
	/** 서버가 바로 문제를 만들 수 있으면 여기에 담아 라우트가 백그라운드로 돌린다. */
	generateQuizId: string | null;
}

/**
 * 재도전을 시작한다 — 같은 책의 `round+1` 퀴즈와 새 배정을 만든다.
 *
 * 문제 생성은 여기서 하지 않는다. 서버가 부를 수 있는 제공자면 라우트가 백그라운드로 돌리고,
 * Gemini 면 부모의 브라우저가 해야 한다(`NEEDS_PARENT`).
 *
 * 두 번 눌러도 판이 둘로 늘지 않는다 — 이미 만들어 둔 다음 판이 있으면 그것을 돌려준다.
 */
export async function start(
	env: AppEnv,
	childId: string,
	attemptId: string,
	now = Date.now(),
): Promise<RetryResult> {
	const current = await state(env, childId, attemptId, now);

	if (current.status === "PASSED") throw conflict("이미 통과한 퀴즈입니다.");
	if (current.status === "COOLDOWN") {
		throw conflict(
			current.waitSeconds > 0
				? `${Math.ceil(current.waitSeconds / 60)}분 뒤에 다시 도전할 수 있어요.`
				: "아직 다시 도전할 수 없어요.",
		);
	}
	// 이미 다음 판이 있다. 새로 만들지 않는다.
	if (current.status !== "READY") return { state: current, generateQuizId: null };

	const attempt = await attemptsRepo.findSummary(env, attemptId);
	const previous = await quizzesRepo.find(env, attempt!.quiz_id);
	if (!previous) throw notFound("퀴즈를 찾을 수 없습니다.");

	const book = await booksRepo.findOwned(env, previous.parent_user_id, previous.book_id);
	if (!book?.brief) throw invalid("책 정보가 없어 새 문제를 만들 수 없습니다.");

	// 출제 기준은 **직전 퀴즈에서** 가져온다. 부모가 그 사이 설정을 바꿨더라도 같은 조건으로
	// 재도전하는 것이 공평하고, 언어가 바뀌면 아이가 갑자기 다른 언어의 문제를 만난다.
	const quizId = newId();
	await quizzesRepo.insert(env, {
		id: quizId,
		bookId: previous.book_id,
		parentUserId: previous.parent_user_id,
		round: await quizzesRepo.nextRound(env, previous.book_id),
		questionCount: previous.question_count,
		passCount: previous.pass_count,
		language: previous.language,
	});

	const assignmentId = newId();
	// 배정은 지금 만들지만 **퀴즈 상태는 건드리지 않는다.** 퀴즈는 DRAFT → GENERATING →
	// REVIEW 라는 평소 경로를 그대로 걷고, 아이 화면은 문항이 다 찼는지로 풀 수 있는지를 판단한다.
	// 여기서 ASSIGNED 로 옮기면 문항이 0개인 퀴즈가 "풀 수 있음" 으로 보인다.
	await assignmentsRepo.insert(env, {
		id: assignmentId,
		quizId,
		parentUserId: previous.parent_user_id,
		childId,
	});

	const canGenerate = await serverCanGenerate(env, previous.parent_user_id);

	return {
		state: {
			status: canGenerate ? "PREPARING" : "NEEDS_PARENT",
			waitSeconds: 0,
			availableAt: null,
			nextAssignmentId: assignmentId,
			prepared: 0,
			total: previous.question_count,
			error: null,
		},
		generateQuizId: canGenerate ? quizId : null,
	};
}
