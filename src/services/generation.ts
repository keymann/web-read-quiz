import { withModelFallback } from "../ai/fallback";
import { generateQuestions, type GeneratedQuestion } from "../ai/generate";
import { validateQuestions, type Verdict } from "../ai/validate";
import * as booksRepo from "../repositories/books";
import * as questionsRepo from "../repositories/questions";
import type { ValidationRecord } from "../repositories/questions";
import * as quizzesRepo from "../repositories/quizzes";
import type { AppEnv, ChoiceNumber, Difficulty, QuestionLanguage, QuestionType } from "../types";
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

/**
 * 필요한 수보다 **조금 더** 요청한다.
 *
 * 실측(Phase 3, n=5): 1라운드 탈락이 2,0,1,0,2 였고 5회 중 3회가 2라운드로 넘어갔다.
 * 라운드 하나는 AI 호출 2회(생성+검수)라 시간이 거의 두 배가 된다.
 *
 * 반면 문항을 몇 개 더 요청하는 비용은 **출력 토큰뿐**이다. 요청 본문 크기는 문항 수와
 * 무관하다(실측: 5·10·12·20문항 모두 4.5KB) — 프롬프트는 "N개 만들어 주세요" 한 줄만 다르다.
 *
 *   여유분 없이 2라운드   호출 4회, 출력 100% + 소량
 *   여유분 20%로 1라운드  호출 2회, 출력 120%
 *
 * 남는 문항은 저장하지 않고 버린다(`applyVerdicts` 의 `room`).
 */
export const withBuffer = (need: number): number =>
	need + Math.min(5, Math.max(1, Math.ceil(need * 0.2)));

/**
 * 한 번의 AI 호출에 몰아넣지 않고 나눠서 **동시에** 부른다.
 *
 * 구조화 출력은 출력 토큰을 만드는 시간이 곧 임계 경로다. 20문항에 여유분을 더한 24문항을
 * 한 응답으로 뽑으면 그것만 60~90초가 걸린다. 8문항씩 셋으로 나눠 나란히 부르면 벽시계가
 * 대략 셋 중 가장 느린 하나로 줄어든다.
 *
 * 쪼갠 만큼 위험도 생긴다 — 청크끼리 서로의 결과를 못 보므로 비슷한 문제가 겹칠 수 있다.
 * 그건 `screen()` 이 배치 안의 중복까지 걸러 주고(같은 `seen` 목록에 쌓는다), 겹쳐서 줄어든
 * 만큼은 아래 여유분이 메운다.
 */
const MAX_PARALLEL_CALLS = 3;

/** 이보다 잘게 쪼개면 중복만 늘고 얻는 시간이 없다. */
const MIN_CHUNK = 6;

/**
 * 요청 `want` 개를 몇 번에 나눠 부를지. 적게 필요할 때는 나누지 않는다.
 *
 * 나눠 부르면 청크끼리 서로의 결과를 못 봐 비슷한 문제가 겹칠 수 있다. 그래서 나눌 때만
 * **나눈 수만큼 더** 뽑는다 — 겹쳐서 모자라 라운드를 한 번 더 도는 편이 문항 몇 개를 더
 * 뽑는 것보다 훨씬 비싸다.
 *
 *   24개 → [9, 9, 9]   12개 → [7, 7]   7개 → [7]
 */
export function planChunks(want: number): number[] {
	const count = Math.min(MAX_PARALLEL_CALLS, Math.max(1, Math.floor(want / MIN_CHUNK)));
	const total = count > 1 ? want + count : want;
	const base = Math.floor(total / count);
	const extra = total % count;
	return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * 청크를 합치면 문항 번호가 겹친다(각 청크가 1번부터 매긴다). 번호는 검수 결과를 문항에
 * 도로 잇는 열쇠라(`applyVerdicts`), 합친 자리에서 다시 매겨 유일하게 만든다.
 */
export const renumber = (questions: GeneratedQuestion[]): GeneratedQuestion[] =>
	questions.map((question, index) => ({ ...question, questionNumber: index + 1 }));

/** 전부 실패했을 때 올릴 오류. 첫 번째 사유가 가장 설명이 된다. */
const firstReason = (settled: PromiseSettledResult<unknown>[]): unknown =>
	settled.find((r) => r.status === "rejected")?.reason ??
	new Error("문제를 만들지 못했습니다.");

/** 배열을 `size` 개씩 자른다. */
const sliceInto = <T>(items: T[], size: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
};

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
	/** 이 퀴즈만 다른 언어로 낼 때. 없으면 부모 설정의 기본 언어. */
	languageOverride?: QuestionLanguage,
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
	const defaults = await settings.getQuizSettings(env, userId);
	// 이 판만 다른 언어로 낼 수 있다. 고르지 않으면 부모의 기본값.
	const language = languageOverride ?? defaults.questionLanguage;
	if (!settings.isQuestionLanguage(language)) {
		throw invalid("문제 언어는 영어 또는 한국어만 고를 수 있습니다.");
	}

	await quizzesRepo.insert(env, {
		id: quizId,
		bookId,
		parentUserId: userId,
		round,
		questionCount: defaults.questionCount,
		passCount: defaults.passCount,
		language,
	});

	const row = await quizzesRepo.findOwned(env, userId, quizId);
	if (!row) throw new ApiError("internal", "퀴즈를 만들지 못했습니다.", 500);
	return row;
}

/* ── 생성 실행 ───────────────────────────────────────── */

/**
 * 부모가 취소를 눌렀는지. 각 단계 사이에서 확인한다.
 *
 * AI 호출 한 번이 10~30초라 **호출 중간에는 멈출 수 없다.** 그래서 취소를 눌러도 실제로는
 * 지금 돌고 있는 호출이 끝난 뒤에 멈춘다. 대신 그때까지 통과한 문항은 버리지 않고 저장한다 —
 * 30초를 기다린 결과를 취소했다고 없애면 그 비용이 그냥 사라진다.
 */
async function cancelled(env: AppEnv, quizId: string): Promise<boolean> {
	return quizzesRepo.isCancelled(env, quizId);
}

/**
 * 취소로 끝낼 때의 마무리. 상태만 되돌린다.
 *
 * 통과한 문항은 라운드마다 이미 저장돼 있다. 예전에는 여기서 저장했는데, 그때는 모든
 * 라운드가 끝나야 저장했기 때문이다.
 */
async function finishCancelled(
	env: AppEnv,
	quizId: string,
	kept: number,
	saved: number,
): Promise<void> {
	const total = kept + saved;
	await quizzesRepo.setStatus(
		env,
		quizId,
		total > 0 ? "REVIEW" : "DRAFT",
		saved > 0
			? `문제 만들기를 멈췄습니다. 그때까지 만든 ${saved}문제는 저장했습니다.`
			: "문제 만들기를 멈췄습니다.",
	);
}

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

		// 남아 있는 문항은 그대로 두고 **빈 자리만** 채운다.
		//
		// 예전에는 여기서 전부 비활성화했다. 그러면 부모가 3번 문제 하나만 다시 만들려고 해도
		// 나머지 열아홉 개가 통째로 새로 만들어진다 — 애써 확인한 문항이 사라지고 비용도 그만큼
		// 든다. 지울 문항은 부모가 검수 화면에서 고르고(§21.7), 여기는 채우기만 한다.
		// 브라우저 릴레이 경로(relay.planGenerate)도 같은 규칙으로 돈다.
		const kept = await questionsRepo.listActive(env, quizId);

		const ai = await settings.getRuntime(env, userId);
		// 근거가 웹 검색이 아니라 모델 지식뿐이면 출제도 보수적으로 가야 한다(Phase 3.5).
		const briefIsUnverified = !(await hasWebSource(env, quiz.book_id));

		const target = quiz.question_count - kept.length;
		if (target <= 0) {
			await quizzesRepo.setStatus(env, quizId, "REVIEW", null);
			return;
		}

		// 이미 있는 문항과 겹치는 문제를 만들지 않도록 본문을 프롬프트와 중복 검사에 넘긴다.
		const keptTexts = kept.map((q) => q.question_text);
		/** 이번 실행에서 **이미 저장한** 문항. 다음 라운드의 중복 회피와 마지막 로그에 쓴다. */
		const saved: GeneratedQuestion[] = [];
		const rejected: { questionText: string; reason: string }[] = [];

		for (let round = 1; round <= MAX_ROUNDS && saved.length < target; round++) {
			const need = target - saved.length;
			const existing = [...keptTexts, ...saved.map((q) => q.questionText)];

			if (await cancelled(env, quizId)) {
				return finishCancelled(env, quizId, kept.length, saved.length);
			}
			await quizzesRepo.setPhase(env, quizId, round === 1 ? "generating" : "retrying");

			// 나눠서 동시에 부른다. 몇 개씩 몇 번에 나눌지는 `planChunks` 가 정한다.
			const chunks = planChunks(withBuffer(need));

			/*
			 * 하나가 실패해도 나머지로 간다.
			 *
			 * `Promise.all` 이면 청크 하나가 넘어질 때 라운드 전체가 무너진다. 나눠 부르는
			 * 만큼 실패할 자리도 늘어나므로, 예전(호출 하나)보다 오히려 잘 깨지게 된다.
			 * 전부 실패했을 때만 예전처럼 오류를 올린다.
			 */
			const settled = await Promise.allSettled(
				chunks.map((count) =>
					withModelFallback(ai.provider, ai.apiKey, ai.model, (model) =>
						generateQuestions({
							provider: ai.provider,
							apiKey: ai.apiKey,
							model,
							brief,
							count,
							existing,
							rejected: rejected.slice(-RECENT_REJECTIONS),
							briefIsUnverified,
							language: quiz.language,
						}),
					).then((r) => r.value),
				),
			);
			const batches = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
			if (batches.length === 0) throw firstReason(settled);

			// 청크마다 1번부터 매겨 오므로 합친 자리에서 다시 매긴다.
			const fresh = renumber(batches.flat());

			if (await cancelled(env, quizId)) {
				return finishCancelled(env, quizId, kept.length, saved.length);
			}
			await quizzesRepo.setPhase(env, quizId, "screening");

			// 1) AI 를 부르기 전에 서버가 걸러낸다. 여기서 줄어든 만큼 검증 비용이 준다.
			//    청크 사이의 중복도 여기서 걸린다 — 같은 `seen` 목록에 쌓으며 훑기 때문이다.
			const screened = screen(fresh, {
				accepted: existing,
				title: book.title,
				author: book.author ?? "",
				brief,
			});
			for (const failure of screened.failed) {
				const source = fresh.find((q) => q.questionNumber === failure.questionNumber);
				if (source) rejected.push({ questionText: source.questionText, reason: failure.reason });
			}
			if (screened.passed.length === 0) continue;

			await quizzesRepo.setPhase(env, quizId, "validating");

			// 2) 살아남은 문항만 AI 검증에 보낸다. 이쪽도 나눠서 동시에 부른다.
			const groups = sliceInto(
				screened.passed,
				Math.ceil(screened.passed.length / chunks.length),
			);
			const judged = await Promise.allSettled(
				groups.map((questions) =>
					withModelFallback(ai.provider, ai.apiKey, ai.model, (model) =>
						validateQuestions({
							provider: ai.provider,
							apiKey: ai.apiKey,
							model,
							brief,
							questions,
							language: quiz.language,
						}),
					).then((r) => r.value),
				),
			);

			/*
			 * 검수를 못 받은 묶음은 **아예 없던 것으로 친다.**
			 *
			 * 판정이 없는 문항을 그대로 넘기면 `applyVerdicts` 가 탈락으로 처리한다. 그러면
			 * 심사조차 받지 못한 문항이 "이렇게 만들지 마라" 목록에 올라 다음 라운드 프롬프트를
			 * 잘못 이끈다.
			 */
			const reviewed: GeneratedQuestion[] = [];
			const verdicts: Verdict[] = [];
			judged.forEach((result, index) => {
				if (result.status !== "fulfilled") return;
				reviewed.push(...groups[index]!);
				verdicts.push(...result.value);
			});
			if (reviewed.length === 0) throw firstReason(judged);

			// 루프 변수 `round` 를 가리지 않게 다른 이름을 쓴다. 예전에는 같은 이름이라
			// 이 줄 위에서 라운드 번호를 읽을 수 없었다.
			const outcome = applyVerdicts(reviewed, verdicts, target - saved.length);
			rejected.push(...outcome.rejected);

			/*
			 * **라운드마다 저장한다.**
			 *
			 * 예전에는 모든 라운드가 끝난 뒤에 한꺼번에 넣었다. 그동안 화면의 진행률은
			 * `0 / 20` 에 멈춰 있어, 1~3분 내내 아무 일도 일어나지 않는 것처럼 보였다.
			 * 번호는 `persistAccepted` 가 그때그때 비어 있는 자리를 찾아 매기므로 나눠
			 * 넣어도 부딪히지 않는다.
			 */
			if (outcome.accepted.length > 0) {
				await quizzesRepo.setPhase(env, quizId, "saving");
				await persistAccepted(env, quizId, outcome.accepted);
				saved.push(...outcome.accepted.map((a) => a.question));
			}
		}

		if (saved.length === 0) {
			const notice = shortfallNotice(quiz.question_count, kept.length, rejected);
			await quizzesRepo.setStatus(env, quizId, kept.length > 0 ? "REVIEW" : "DRAFT", notice);
			return;
		}

		const total = kept.length + saved.length;
		const shortfall = quiz.question_count - total;

		await quizzesRepo.setStatus(
			env,
			quizId,
			"REVIEW",
			shortfall > 0 ? shortfallNotice(quiz.question_count, total, rejected) : null,
		);

		console.log(
			`quiz ${quizId}: ${total}/${quiz.question_count} accepted, ${rejected.length} rejected`,
			typeDistribution(saved),
		);
	} catch (err) {
		console.error("generation failed", err);
		const message =
			err instanceof ApiError ? err.message : "문제를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.";
		await quizzesRepo.setStatus(env, quizId, "DRAFT", message);
	}
}

/**
 * 한 문제도 못 만들었을 때 부모에게 보여줄 말.
 *
 * "검수를 통과한 문제가 없습니다" 만으로는 무엇을 해야 할지 알 수 없다. 탈락 사유의 대부분이
 * **근거 부족**이라면 원인은 모델이 아니라 책 정보다 — AI 가 지어내는 것을 서버가 막은 것이고,
 * 부모가 할 일은 다시 생성이 아니라 책 정보를 채우는 것이다.
 */
function failureNotice(rejected: { reason: string }[]): string {
	const ungrounded = rejected.filter((r) => r.reason.includes("제공된 책 정보")).length;

	if (rejected.length > 0 && ungrounded >= rejected.length / 2) {
		return (
			"책 정보가 부족해 근거를 댈 수 있는 문제를 만들지 못했습니다. " +
			"AI 가 지어낸 내용은 서버가 걸러냅니다. 책 화면에서 '정보 다시 찾기' 로 줄거리를 보강해 주세요."
		);
	}

	return "검수를 통과한 문제가 없습니다. 책 정보를 보강하고 다시 시도해 주세요.";
}

/** 탈락 사유의 절반 이상이 근거 부족이면, 문제는 모델이 아니라 책 정보다. */
export const mostlyUngrounded = (rejected: { reason: string }[]): boolean =>
	rejected.length > 0 &&
	rejected.filter((r) => r.reason.includes("제공된 책 정보")).length >= rejected.length / 2;

/**
 * 부족하게 끝났을 때 부모에게 보여줄 말.
 *
 * "검수를 통과한 문제가 없습니다" 만으로는 무엇을 해야 할지 알 수 없다. 근거 부족이 원인이면
 * 부모가 할 일은 **다시 생성이 아니라 책 정보를 채우는 것**이다 — 같은 정보로 다시 돌려도
 * 같은 이유로 걸린다. AI 가 지어낸 것을 서버가 막은 것이므로 이건 고장이 아니다.
 */
export function shortfallNotice(
	target: number,
	total: number,
	rejected: { reason: string }[],
): string {
	const head =
		total === 0
			? "검수를 통과한 문제가 없습니다."
			: `${target}문제 중 ${total}개만 검수를 통과했습니다.`;

	return mostlyUngrounded(rejected)
		? `${head} 책 정보에 없는 내용을 다룬 문항이 많았습니다. AI 가 지어낸 내용은 서버가 걸러냅니다.` +
			" 책 화면에서 '정보 다시 찾기' 로 줄거리를 보강해 주세요."
		: `${head} 다시 생성하면 나머지를 채웁니다.`;
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
): {
	accepted: AcceptedQuestion[];
	rejected: { questionText: string; reason: string }[];
	/** 자리가 없어 못 쓴 **멀쩡한** 문항 수. 여유분을 얹어 요청한 결과다. */
	surplus: number;
} {
	const byNumber = new Map(verdicts.map((v) => [v.questionNumber, v]));
	const accepted: AcceptedQuestion[] = [];
	const rejected: { questionText: string; reason: string }[] = [];
	let surplus = 0;

	for (const question of questions) {
		const verdict = byNumber.get(question.questionNumber);
		const ok = verdict !== undefined && passes(verdict);

		if (ok && accepted.length >= room) {
			// **탈락이 아니다.** 검수를 통과했지만 자리가 찼을 뿐이다.
			//
			// 이걸 rejected 에 넣으면 두 군데가 틀어진다. 다음 라운드 프롬프트가 멀쩡한 문항을
			// "반복하지 마라" 목록에 올리고, 부모에게 보여줄 안내가 통과 수를 실제보다 적게 센다.
			surplus++;
			continue;
		}

		if (!ok) {
			rejected.push({
				questionText: question.questionText,
				reason: verdict?.reason || "검수 기준을 통과하지 못했습니다.",
			});
			continue;
		}

		accepted.push({ question, verdict });
	}

	return { accepted, rejected, surplus };
}

/** 통과한 문항을 저장한다. 번호는 지금 비어 있는 자리부터 채운다. */
export async function persistAccepted(
	env: AppEnv,
	quizId: string,
	accepted: AcceptedQuestion[],
): Promise<void> {
	// 정답 위치는 모델에게 맡기지 않고 서버가 고르게 편다(§9-10).
	const balanced = balanceAnswerPositions(accepted.map((a) => a.question));

	// 번호는 "지금 비어 있는 자리" 를 채운다. 이어붙이기로 매기면 부모가 3번만 다시 만들었을 때
	// 새 문항이 이미 있는 번호와 부딪힌다(활성 문항 안에서 번호는 유일해야 한다).
	const free = freeNumbers(await questionsRepo.activeNumbers(env, quizId), balanced.length);

	const validations = new Map<number, ValidationRecord>();
	const rows = balanced.map((question, index) => {
		const number = free[index]!;
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

/** 쓰이지 않는 가장 작은 번호부터 `count` 개. */
function freeNumbers(used: number[], count: number): number[] {
	const taken = new Set(used);
	const numbers: number[] = [];

	for (let n = 1; numbers.length < count; n++) {
		if (!taken.has(n)) numbers.push(n);
	}

	return numbers;
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
