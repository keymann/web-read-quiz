import { withModelFallback } from "../ai/fallback";
import { generateQuestions, type GeneratedQuestion } from "../ai/generate";
import { validateQuestions, type Verdict } from "../ai/validate";
import * as booksRepo from "../repositories/books";
import * as questionsRepo from "../repositories/questions";
import type { ValidationRecord } from "../repositories/questions";
import * as quizzesRepo from "../repositories/quizzes";
import type { AppEnv, ChoiceNumber, Difficulty, QuestionType } from "../types";
import { newId } from "../utils/id";
import { ApiError, invalid, notFound } from "../utils/response";
import { balanceAnswerPositions, screen, typeDistribution } from "./question-checks";
import * as settings from "./settings";

/**
 * 문제 생성 파이프라인(§28).
 *
 * 목표는 **정상 경로에서 AI 호출 2회**다. 책 식별·검색(Phase 3)은 이미 끝났고 Book Brief 가
 * 저장돼 있으므로 여기서는 생성 1회 + 검증 1회로 끝난다. 20문항을 통째로 다시 만들지 않고
 * 탈락한 문항 수만큼만 재생성한다.
 *
 *   생성(20) → 서버 사후검사 → AI 검증 → 탈락분만 재생성 → 재검증 …
 *
 * 최대 3라운드. 그 뒤에도 20개를 못 채우면 채운 만큼 REVIEW 로 넘기고 사유를 남겨
 * 부모가 수동으로 다시 돌릴 수 있게 한다.
 */

/** 설정이 없을 때의 기본 문항 수. 실제 값은 퀴즈 행에서 읽는다. */
export const DEFAULT_TARGET_QUESTIONS = 20;
const MAX_ROUNDS = 3;

/** 이 점수 아래는 통과시키지 않는다. */
const MIN_SCORE = 70;

/** 재생성 프롬프트에 넣을 탈락 사례 수. 너무 많으면 프롬프트만 길어진다. */
const RECENT_REJECTIONS = 10;

export interface AcceptedQuestion {
	question: GeneratedQuestion;
	verdict: Verdict;
}

export interface GenerationProgress {
	status: string;
	generated: number;
	total: number;
	error: string | null;
}

/* ── 퀴즈 만들기 ─────────────────────────────────────── */

export async function createQuiz(
	env: AppEnv,
	userId: string,
	bookId: string,
): Promise<quizzesRepo.QuizRow> {
	const book = await booksRepo.findOwned(env, userId, bookId);
	if (!book) throw notFound("책을 찾을 수 없습니다.");
	if (!book.brief) {
		throw invalid("먼저 책 정보를 찾아 주세요. 줄거리 없이는 문제를 만들 수 없습니다.");
	}

	const quizId = newId();
	// 같은 책에 대해 여러 회차가 쌓인다(§18 재도전).
	const round = await quizzesRepo.nextRound(env, bookId);

	// 설정값을 퀴즈에 **복사해 둔다.** 나중에 설정을 바꿔도 이미 만든 퀴즈의 기준은 그대로여야 한다.
	const { questionCount, passCount } = await settings.getQuizSettings(env, userId);

	await quizzesRepo.insert(env, {
		id: quizId,
		bookId,
		parentUserId: userId,
		round,
		questionCount,
		passCount,
	});

	const row = await quizzesRepo.findOwned(env, userId, quizId);
	if (!row) throw new ApiError("internal", "퀴즈를 만들지 못했습니다.", 500);
	return row;
}

/* ── 생성 실행 ───────────────────────────────────────── */

/**
 * 백그라운드에서 도는 본체.
 *
 * 라우트는 이 함수를 `ctx.waitUntil` 에 넘기고 곧바로 202 를 돌려준다. 20문항 생성과 검증은
 * 수십 초가 걸려 요청을 붙잡고 있을 수 없다. 진행 상황은 저장된 문항 수로 폴링한다.
 *
 * 어떤 경우에도 예외를 밖으로 내보내지 않는다. 백그라운드에서 터지면 아무도 못 보므로,
 * 실패 사유를 반드시 `generation_error` 에 남겨 부모가 화면에서 읽을 수 있게 한다.
 */
export async function runGeneration(env: AppEnv, userId: string, quizId: string): Promise<void> {
	try {
		const quiz = await quizzesRepo.findOwned(env, userId, quizId);
		if (!quiz) return;

		const book = await booksRepo.findOwned(env, userId, quiz.book_id);
		const brief = book?.brief;
		if (!book || !brief) {
			await quizzesRepo.setStatus(env, quizId, "DRAFT", "책 정보(Brief)가 없습니다.");
			return;
		}

		// 다시 돌리는 경우 이전 시도의 문항을 치운다. 행은 남기고 비활성화만 한다(§21.7).
		await questionsRepo.deactivateAll(env, quizId);

		const ai = await settings.getRuntime(env, userId);
		// 근거가 웹 검색이 아니라 모델 지식뿐이면 출제도 보수적으로 가야 한다(Phase 3.5).
		const briefIsUnverified = !(await hasWebSource(env, quiz.book_id));

		const target = quiz.question_count;
		const accepted: AcceptedQuestion[] = [];
		const rejected: { questionText: string; reason: string }[] = [];

		for (let round = 1; round <= MAX_ROUNDS && accepted.length < target; round++) {
			const need = target - accepted.length;

			const { value: fresh } = await withModelFallback(ai.provider, ai.apiKey, ai.model, (model) =>
				generateQuestions({
					provider: ai.provider,
					apiKey: ai.apiKey,
					model,
					brief,
					count: need,
					existing: accepted.map((a) => a.question.questionText),
					rejected: rejected.slice(-RECENT_REJECTIONS),
					briefIsUnverified,
				}),
			);

			// 1) AI 를 부르기 전에 서버가 걸러낸다. 여기서 줄어든 만큼 검증 비용이 준다.
			const screened = screen(fresh, {
				accepted: accepted.map((a) => a.question.questionText),
				title: book.title,
				author: book.author ?? "",
			});
			for (const failure of screened.failed) {
				const source = fresh.find((q) => q.questionNumber === failure.questionNumber);
				if (source) rejected.push({ questionText: source.questionText, reason: failure.reason });
			}
			if (screened.passed.length === 0) continue;

			// 2) 살아남은 문항만 AI 검증에 보낸다.
			const { value: verdicts } = await withModelFallback(ai.provider, ai.apiKey, ai.model, (model) =>
				validateQuestions({
					provider: ai.provider,
					apiKey: ai.apiKey,
					model,
					brief,
					questions: screened.passed,
				}),
			);

			const round = applyVerdicts(screened.passed, verdicts, target - accepted.length);
			accepted.push(...round.accepted);
			rejected.push(...round.rejected);
		}

		if (accepted.length === 0) {
			await quizzesRepo.setStatus(
				env,
				quizId,
				"DRAFT",
				"검수를 통과한 문제가 없습니다. 책 정보를 보강하고 다시 시도해 주세요.",
			);
			return;
		}

		await persistAccepted(env, quizId, 0, accepted);

		const shortfall = target - accepted.length;
		await quizzesRepo.setStatus(
			env,
			quizId,
			"REVIEW",
			shortfall > 0
				? `${target}문제 중 ${accepted.length}개만 검수를 통과했습니다. 다시 생성하면 나머지를 채웁니다.`
				: null,
		);

		console.log(
			`quiz ${quizId}: ${accepted.length}/${target} accepted, ${rejected.length} rejected`,
			typeDistribution(accepted.map((a) => a.question)),
		);
	} catch (err) {
		console.error("generation failed", err);
		const message =
			err instanceof ApiError ? err.message : "문제를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.";
		await quizzesRepo.setStatus(env, quizId, "DRAFT", message);
	}
}

const passes = (verdict: Verdict): boolean =>
	verdict.valid && verdict.score >= MIN_SCORE && verdict.readRequired;

/**
 * 판정을 문항에 맞춰 통과·탈락으로 가른다.
 *
 * 서버가 부르든 브라우저가 부르든 **임계값은 여기 하나뿐**이다. `room` 은 남은 자리 수로,
 * 목표를 넘겨 저장하지 않게 한다.
 */
export function applyVerdicts(
	questions: GeneratedQuestion[],
	verdicts: Verdict[],
	room: number,
): { accepted: AcceptedQuestion[]; rejected: { questionText: string; reason: string }[] } {
	const byNumber = new Map(verdicts.map((v) => [v.questionNumber, v]));
	const accepted: AcceptedQuestion[] = [];
	const rejected: { questionText: string; reason: string }[] = [];

	for (const question of questions) {
		const verdict = byNumber.get(question.questionNumber);
		if (accepted.length >= room || !verdict || !passes(verdict)) {
			rejected.push({
				questionText: question.questionText,
				reason: verdict?.reason || "검수 기준을 통과하지 못했습니다.",
			});
			continue;
		}
		accepted.push({ question, verdict });
	}

	return { accepted, rejected };
}

/** 통과한 문항을 저장한다. `startNumber` 는 이미 저장된 문항 수(번호를 이어 붙이기 위해). */
export async function persistAccepted(
	env: AppEnv,
	quizId: string,
	startNumber: number,
	accepted: AcceptedQuestion[],
): Promise<void> {
	// 정답 위치는 모델에게 맡기지 않고 서버가 고르게 편다(§9-10).
	const balanced = balanceAnswerPositions(accepted.map((a) => a.question));

	const validations = new Map<number, ValidationRecord>();
	const rows = balanced.map((question, index) => {
		const number = startNumber + index + 1;
		const { verdict } = accepted[index]!;
		validations.set(number, {
			valid: verdict.valid,
			score: verdict.score,
			reason: verdict.reason,
			readRequired: verdict.readRequired,
		});

		return {
			quizId,
			questionNumber: number,
			questionText: question.questionText,
			choices: question.choices,
			correctChoice: question.correctChoice as ChoiceNumber,
			questionType: question.questionType as QuestionType,
			difficulty: question.difficulty as Difficulty,
			explanation: question.explanation,
			evidence: question.evidence,
			readRequired: question.readRequired,
		};
	});

	await questionsRepo.insertGenerated(env, rows, "AI_GENERATED", validations);
}

/** 웹 검색으로 얻은 출처가 하나라도 있는지. 없으면 Brief 가 모델 기억에만 기댄 것이다. */
async function hasWebSource(env: AppEnv, bookId: string): Promise<boolean> {
	const row = await env.DB.prepare(
		"SELECT 1 AS x FROM book_sources WHERE book_id = ? AND source = 'web' LIMIT 1",
	)
		.bind(bookId)
		.first<{ x: number }>();
	return row !== null;
}

/* ── 조회 ────────────────────────────────────────────── */

export async function progress(
	env: AppEnv,
	userId: string,
	quizId: string,
): Promise<GenerationProgress> {
	const quiz = await quizzesRepo.findOwned(env, userId, quizId);
	if (!quiz) throw notFound("퀴즈를 찾을 수 없습니다.");

	return {
		status: quiz.status,
		generated: await questionsRepo.countActive(env, quizId),
		total: quiz.question_count,
		error: quiz.generation_error,
	};
}
