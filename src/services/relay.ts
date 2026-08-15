import { buildGenerateRequest, type GeneratedQuestion } from "../ai/generate";
import { buildGeminiCall } from "../ai/gemini";
import { parseGenerateContentResponse } from "../ai/google-shared";
import { buildValidateRequest, type Verdict } from "../ai/validate";
import { buildIdentifyRequest, type BookIdentity } from "../ai/vision";
import * as booksRepo from "../repositories/books";
import * as questionsRepo from "../repositories/questions";
import * as quizzesRepo from "../repositories/quizzes";
import * as settingsRepo from "../repositories/settings";
import { buildResearchRequest, normalizeResearch, type BookResearch } from "../search/web";
import * as bibliographic from "../search/bibliographic";
import type { AppEnv } from "../types";
import { unseal } from "../utils/crypto";
import { forbidden, invalid, notFound } from "../utils/response";
import * as book from "./book";
import { screen } from "./question-checks";
import * as generation from "./generation";
import * as settings from "./settings";

/**
 * 브라우저 릴레이.
 *
 * AI Studio 의 Gemini API 는 요청을 보낸 **서버**의 위치를 보고 막는다. Cloudflare Worker 는
 * 홍콩 콜로에서 나가는데 홍콩은 Gemini 미지원 지역이다. 반면 부모의 브라우저는 지원 지역에
 * 있으므로, 브라우저가 대신 Gemini 를 부르면 통과한다.
 *
 * 대신 **부모의 API Key 가 부모의 브라우저에 내려간다.** 요구사항 §24 가 금지하는 구조이므로
 * 다음 조건을 걸었다.
 *  1. 키는 PARENT 세션에만, 전용 엔드포인트로만 내려간다.
 *  2. 브라우저는 저장하지 않고 작업 중 메모리에만 들고 있는다.
 *  3. CSP `connect-src` 는 Gemini 호스트 하나만 추가로 허용한다.
 *  4. **제공자가 gemini 일 때만** 이 경로를 연다. OpenAI·Vertex 는 서버가 그대로 부른다.
 *
 * 설계상 중요한 점: 브라우저는 **요청을 만들지도, 결과를 판정하지도 않는다.** 서버가 완성된
 * 요청 본문을 내려주고, 브라우저는 키만 붙여 보낸 뒤 응답을 그대로 돌려준다. 프롬프트·스키마가
 * 클라이언트로 복사되지 않고, 품질 게이트(사후검사·검증 임계값·정답 위치 균등화)도 서버에 남는다.
 */

/** 이 경로를 열어 주는 유일한 제공자. */
const RELAY_PROVIDER = "gemini";

export interface Credential {
	apiKey: string;
	model: string;
	visionModel: string;
}

/**
 * 브라우저가 쓸 자격증명. **이 함수가 키를 클라이언트로 내보내는 유일한 통로다.**
 * 제공자가 gemini 가 아니면 열지 않는다 — 다른 제공자는 서버가 직접 부를 수 있기 때문이다.
 */
export async function credential(env: AppEnv, userId: string): Promise<Credential> {
	const row = await settingsRepo.find(env, userId);
	if (!row?.api_key_cipher || !row.api_key_iv) {
		throw invalid("먼저 설정 화면에서 AI API Key 를 등록해 주세요.");
	}
	if (row.ai_provider !== RELAY_PROVIDER) {
		throw forbidden("이 제공자는 브라우저에서 직접 호출하지 않습니다.");
	}

	const { model, visionModel } = await settings.getRuntime(env, userId);
	return {
		apiKey: await unseal(env, { cipher: row.api_key_cipher, iv: row.api_key_iv }),
		model,
		visionModel,
	};
}

/** 브라우저가 그대로 보내면 되는 요청. */
export interface PlannedCall {
	url: string;
	body: unknown;
}

async function assertRelayProvider(env: AppEnv, userId: string): Promise<void> {
	const row = await settingsRepo.find(env, userId);
	if (row?.ai_provider !== RELAY_PROVIDER) {
		throw forbidden("이 제공자는 브라우저에서 직접 호출하지 않습니다.");
	}
}

/* ── 1. 표지 식별 ────────────────────────────────────── */

export async function planIdentify(
	env: AppEnv,
	userId: string,
	bookId: string,
): Promise<PlannedCall> {
	await assertRelayProvider(env, userId);

	const row = await book.requireOwned(env, userId, bookId);
	if (!row.cover_key) throw invalid("표지 이미지가 없습니다.");

	const stored = await env.IMAGES.get(row.cover_key, "arrayBuffer");
	if (!stored) throw invalid("표지 이미지를 찾을 수 없습니다.");

	const { visionModel } = await settings.getRuntime(env, userId);
	return buildGeminiCall(
		buildIdentifyRequest(visionModel, {
			bytes: new Uint8Array(stored),
			mime: row.cover_mime ?? "image/jpeg",
		}),
	);
}

export async function applyIdentify(
	env: AppEnv,
	userId: string,
	bookId: string,
	response: unknown,
): Promise<unknown> {
	await assertRelayProvider(env, userId);
	// 브라우저가 보낸 것은 **Gemini 의 원본 응답**이다. 파싱과 스키마 해석은 서버가 한다.
	const identity = parseGenerateContentResponse<BookIdentity>("gemini", response as never);
	return book.applyIdentity(env, userId, bookId, identity);
}

/* ── 2. 책 정보 조사 ─────────────────────────────────── */

export async function planResearch(
	env: AppEnv,
	userId: string,
	bookId: string,
	useWebSearch: boolean,
): Promise<PlannedCall> {
	await assertRelayProvider(env, userId);

	const row = await book.requireOwned(env, userId, bookId);
	if (!row.title || row.title === "(분석 전)") {
		throw invalid("먼저 책 정보를 분석하거나 제목을 입력해 주세요.");
	}

	const { model } = await settings.getRuntime(env, userId);
	const bib = await bibliographic.lookup({
		isbn: row.isbn13 ?? row.isbn10 ?? "",
		title: row.title,
		author: row.author ?? "",
		publisher: row.publisher ?? "",
	});

	return buildGeminiCall(
		buildResearchRequest(
			model,
			{
				title: row.title,
				author: row.author ?? "",
				publisher: row.publisher ?? "",
				isbn: row.isbn13 ?? row.isbn10 ?? "",
				bib,
			},
			useWebSearch,
		),
	);
}

export async function applyResearch(
	env: AppEnv,
	userId: string,
	bookId: string,
	response: unknown,
	groundingUsed: boolean,
): Promise<unknown> {
	await assertRelayProvider(env, userId);

	const raw = parseGenerateContentResponse<BookResearch>("gemini", response as never);
	return book.applyResearch(env, userId, bookId, normalizeResearch(raw), {
		groundingUsed,
		searchNotice: groundingUsed
			? null
			: "이 키로는 웹 검색을 쓸 수 없어 모델이 아는 지식으로 정리했습니다. 책 정보를 꼭 직접 확인해 주세요.",
		modelNotice: null,
	});
}

/* ── 3. 문제 생성 ────────────────────────────────────── */

export interface GeneratePlan extends Partial<PlannedCall> {
	/** 목표를 이미 채웠으면 더 부를 필요가 없다. */
	done: boolean;
	need: number;
	target: number;
	accepted: number;
}

export async function planGenerate(
	env: AppEnv,
	userId: string,
	quizId: string,
	rejected: { questionText: string; reason: string }[],
): Promise<GeneratePlan> {
	await assertRelayProvider(env, userId);

	const quiz = await quizzesRepo.findOwned(env, userId, quizId);
	if (!quiz) throw notFound("퀴즈를 찾을 수 없습니다.");

	const bookRow = await booksRepo.findOwned(env, userId, quiz.book_id);
	const brief = bookRow?.brief;
	if (!brief) throw invalid("먼저 책 정보를 찾아 주세요.");

	const existing = await questionsRepo.listActive(env, quizId);
	const need = quiz.question_count - existing.length;
	if (need <= 0) {
		return { done: true, need: 0, target: quiz.question_count, accepted: existing.length };
	}

	const { model } = await settings.getRuntime(env, userId);
	const hasWeb = await hasWebSource(env, quiz.book_id);

	const call = buildGeminiCall(
		buildGenerateRequest({
			// 조립에만 쓰므로 실제 호출 경로는 필요 없다.
			provider: null as never,
			apiKey: "",
			model,
			brief,
			count: need,
			existing: existing.map((q) => q.question_text),
			rejected: rejected.slice(-10),
			briefIsUnverified: !hasWeb,
		}),
	);

	return { done: false, need, target: quiz.question_count, accepted: existing.length, ...call };
}

export interface ValidatePlan extends Partial<PlannedCall> {
	/** 사후검사를 통과해 검증으로 보낼 문항. 브라우저는 이걸 그대로 accept 단계에 돌려준다. */
	questions: GeneratedQuestion[];
	rejected: { questionText: string; reason: string }[];
}

/**
 * 생성 응답을 받아 **서버가 사후검사를 돌린 뒤** 검증 요청을 만든다.
 * 선택지 중복·근거 누락·제목 노출·기존 문항과의 중복은 여기서 걸러진다(§7·§9·§10).
 */
export async function planValidate(
	env: AppEnv,
	userId: string,
	quizId: string,
	response: unknown,
): Promise<ValidatePlan> {
	await assertRelayProvider(env, userId);

	const quiz = await quizzesRepo.findOwned(env, userId, quizId);
	if (!quiz) throw notFound("퀴즈를 찾을 수 없습니다.");

	const bookRow = await booksRepo.findOwned(env, userId, quiz.book_id);
	const brief = bookRow?.brief;
	if (!bookRow || !brief) throw invalid("책 정보(Brief)가 없습니다.");

	const generated = parseGenerateContentResponse<{ questions: GeneratedQuestion[] }>(
		"gemini",
		response as never,
	);

	const existing = await questionsRepo.listActive(env, quizId);
	const screened = screen(generated.questions ?? [], {
		accepted: existing.map((q) => q.question_text),
		title: bookRow.title,
		author: bookRow.author ?? "",
	});

	const rejected = screened.failed.map((failure) => ({
		questionText:
			(generated.questions ?? []).find((q) => q.questionNumber === failure.questionNumber)
				?.questionText ?? "",
		reason: failure.reason,
	}));

	if (screened.passed.length === 0) return { questions: [], rejected };

	const { model } = await settings.getRuntime(env, userId);
	const call = buildGeminiCall(
		buildValidateRequest({
			provider: null as never,
			apiKey: "",
			model,
			brief,
			questions: screened.passed,
		}),
	);

	return { questions: screened.passed, rejected, ...call };
}

export interface AcceptResult {
	accepted: number;
	target: number;
	remaining: number;
	rejected: { questionText: string; reason: string }[];
	done: boolean;
}

/**
 * 검증 결과를 받아 통과한 문항만 저장한다.
 *
 * 브라우저가 문항과 판정을 함께 보내므로 **여기서 한 번 더 사후검사를 돌린다.** 임계값 적용,
 * 정답 위치 균등화, 버전·이력 기록은 모두 서버 몫이다.
 */
export async function applyAccept(
	env: AppEnv,
	userId: string,
	quizId: string,
	questions: GeneratedQuestion[],
	response: unknown,
): Promise<AcceptResult> {
	await assertRelayProvider(env, userId);

	const quiz = await quizzesRepo.findOwned(env, userId, quizId);
	if (!quiz) throw notFound("퀴즈를 찾을 수 없습니다.");

	const bookRow = await booksRepo.findOwned(env, userId, quiz.book_id);
	if (!bookRow) throw notFound("책을 찾을 수 없습니다.");

	const verdicts = parseGenerateContentResponse<{ results: Verdict[] }>("gemini", response as never);

	const existing = await questionsRepo.listActive(env, quizId);
	// 클라이언트가 보낸 문항을 그대로 믿지 않는다. 구조 규칙은 여기서 다시 확인한다.
	const screened = screen(questions, {
		accepted: existing.map((q) => q.question_text),
		title: bookRow.title,
		author: bookRow.author ?? "",
	});

	const room = quiz.question_count - existing.length;
	const { accepted, rejected } = generation.applyVerdicts(
		screened.passed,
		verdicts.results ?? [],
		room,
	);
	for (const failure of screened.failed) {
		const source = questions.find((q) => q.questionNumber === failure.questionNumber);
		if (source) rejected.push({ questionText: source.questionText, reason: failure.reason });
	}

	if (accepted.length > 0) {
		await generation.persistAccepted(env, quizId, existing.length, accepted);
	}

	const total = existing.length + accepted.length;
	return {
		accepted: total,
		target: quiz.question_count,
		remaining: Math.max(0, quiz.question_count - total),
		rejected,
		done: total >= quiz.question_count,
	};
}

async function hasWebSource(env: AppEnv, bookId: string): Promise<boolean> {
	const row = await env.DB.prepare(
		"SELECT 1 AS x FROM book_sources WHERE book_id = ? AND source = 'web' LIMIT 1",
	)
		.bind(bookId)
		.first<{ x: number }>();
	return row !== null;
}
