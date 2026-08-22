import { buildGenerateRequest, type GeneratedQuestion } from "../ai/generate";
import { buildOrientRequest, normalizeOrientation } from "../ai/orient";
import { buildGeminiCall } from "../ai/gemini";
import { extractGroundingSources, parseGenerateContentResponse } from "../ai/google-shared";
import { buildValidateRequest, type Verdict } from "../ai/validate";
import { buildIdentifyRequest, type BookIdentity } from "../ai/vision";
import * as booksRepo from "../repositories/books";
import * as questionsRepo from "../repositories/questions";
import * as quizzesRepo from "../repositories/quizzes";
import * as settingsRepo from "../repositories/settings";
import { buildResearchRequest, normalizeResearch, type BookResearch } from "../search/web";
import type { AppEnv } from "../types";
import { unseal } from "../utils/crypto";
import { ApiError, forbidden, invalid, notFound } from "../utils/response";
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
	/** 이 요청이 쓰는 모델. 브라우저는 실패했을 때 이 값을 avoid 로 되돌려준다. */
	model: string;
	/** 부모가 고른 모델이 아닌 다른 모델을 쓰게 됐으면 그 사실. 정상이면 null. */
	modelNotice: string | null;
}

/**
 * 이번 호출에 쓸 모델을 고른다.
 *
 * 브라우저는 **모델을 고르지 않는다.** 실패했을 때 "이건 안 되더라"만 알려주고, 다음으로
 * 무엇을 쓸지는 여기서 정한다. 서버 호출 경로의 `withModelFallback` 과 같은 역할이고
 * 후보 순서도 같다(키 등록 때 받아 둔 목록).
 *
 * `avoid` 를 다 소진하면 던진다 — 브라우저가 무한히 되물어 보지 못하게 한다.
 */
async function chooseModel(
	env: AppEnv,
	userId: string,
	kind: "text" | "vision",
	avoid: string[],
): Promise<{ model: string; modelNotice: string | null }> {
	const runtime = await settings.getRuntime(env, userId);
	const preferred = kind === "vision" ? runtime.visionModel : runtime.model;

	if (!avoid.includes(preferred)) return { model: preferred, modelNotice: null };

	const candidates = (await settings.storedModels(env, userId)).filter((m) => !avoid.includes(m));
	// 원래 모델까지 포함해 최대 3개. 더 돌면 부모는 하염없이 기다리기만 한다.
	if (candidates.length === 0 || avoid.length >= MAX_MODELS) {
		throw new ApiError(
			"ai_failed",
			"지금은 Gemini 모델이 모두 응답하지 않습니다. 잠시 후 다시 시도해 주세요.",
			502,
		);
	}

	const model = candidates[0]!;
	return {
		model,
		modelNotice: `${preferred} 모델이 응답하지 않아 ${model} 로 바꿔 만들었습니다.`,
	};
}

/** 원래 모델까지 포함해 최대 몇 개를 시도할지. `ai/fallback.ts` 와 같은 기준이다. */
const MAX_MODELS = 3;

async function assertRelayProvider(env: AppEnv, userId: string): Promise<void> {
	const row = await settingsRepo.find(env, userId);
	if (row?.ai_provider !== RELAY_PROVIDER) {
		throw forbidden("이 제공자는 브라우저에서 직접 호출하지 않습니다.");
	}
}

/* ── 0. 표지 방향 ────────────────────────────────────── */

/**
 * 표지가 누워 있는지 묻는 요청. 서지 식별과 같은 이미지, 다른 스키마다.
 *
 * 서지 식별에 얹지 않는 이유는 `ai/orient.ts` 머리말에 적어 두었다 — 이미 등록된 책의 사진도
 * 바로잡아야 하는데, 그때 서지 식별을 다시 돌리면 부모가 고쳐 둔 값이 AI 값으로 덮인다.
 */
export async function planOrient(
	env: AppEnv,
	userId: string,
	bookId: string,
	avoid: string[] = [],
): Promise<PlannedCall> {
	await assertRelayProvider(env, userId);

	const row = await book.requireOwned(env, userId, bookId);
	if (!row.cover_key) throw invalid("표지 이미지가 없습니다.");

	const stored = await env.IMAGES.get(row.cover_key, "arrayBuffer");
	if (!stored) throw invalid("표지 이미지를 찾을 수 없습니다.");

	const { model, modelNotice } = await chooseModel(env, userId, "vision", avoid);
	return {
		...buildGeminiCall(
			buildOrientRequest(model, {
				bytes: new Uint8Array(stored),
				mime: row.cover_mime ?? "image/jpeg",
			}),
		),
		model,
		modelNotice,
	};
}

export async function applyOrient(
	env: AppEnv,
	userId: string,
	bookId: string,
	response: unknown,
): Promise<unknown> {
	await assertRelayProvider(env, userId);
	// 각도를 네 값 중 하나로 좁히는 일도 서버가 한다. 브라우저가 보낸 것은 원본 응답뿐이다.
	const raw = parseGenerateContentResponse<{ rotation: unknown; confidence: unknown }>(
		"gemini",
		response as never,
	);
	return book.applyOrientation(env, userId, bookId, normalizeOrientation(raw));
}

/* ── 1. 표지 식별 ────────────────────────────────────── */

export async function planIdentify(
	env: AppEnv,
	userId: string,
	bookId: string,
	avoid: string[] = [],
): Promise<PlannedCall> {
	await assertRelayProvider(env, userId);

	const row = await book.requireOwned(env, userId, bookId);
	if (!row.cover_key) throw invalid("표지 이미지가 없습니다.");

	const stored = await env.IMAGES.get(row.cover_key, "arrayBuffer");
	if (!stored) throw invalid("표지 이미지를 찾을 수 없습니다.");

	const { model, modelNotice } = await chooseModel(env, userId, "vision", avoid);
	return {
		...buildGeminiCall(
			buildIdentifyRequest(model, {
				bytes: new Uint8Array(stored),
				mime: row.cover_mime ?? "image/jpeg",
			}),
		),
		model,
		modelNotice,
	};
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
	/** 등급 검색을 응답 뒤에도 계속 돌리기 위해 받는다. */
	ctx: ExecutionContext,
	userId: string,
	bookId: string,
	useWebSearch: boolean,
	avoid: string[] = [],
): Promise<PlannedCall> {
	await assertRelayProvider(env, userId);

	const row = await book.requireOwned(env, userId, bookId);
	if (!row.title || row.title === "(분석 전)") {
		throw invalid("먼저 책 정보를 분석하거나 제목을 입력해 주세요.");
	}

	const { model, modelNotice } = await chooseModel(env, userId, "text", avoid);
	/*
	 * 서지와 웹 자료를 **나란히** 받는다(서버 경로의 `book.search` 와 같은 이유).
	 * 둘 다 같은 책 행만 있으면 되는데 줄을 세우면 서지 최대 8초 + Tavily 최대 50초의
	 * 합을 기다린다. 보조 단계라 각자 자기 실패를 삼킨다 — 나란히 돌릴 때 한쪽 거부가
	 * 다른 쪽 거부를 갈 곳 없게 만드는 것도 함께 막는다.
	 *
	 * 여기서 받은 것을 책에 적어 두고, 반영 단계(applyResearch)가 같은 값을 읽는다.
	 * 두 번 부르면 프롬프트가 본 서지와 병합에 쓰는 서지가 달라질 수 있다.
	 */
	const [bib, web] = await Promise.all([
		book.prepareBib(env, userId, row).catch((err: unknown) => {
			console.warn("bibliographic lookup failed", err);
			return [];
		}),
		book.prepareWeb(env, userId, row).catch((err: unknown) => {
			console.warn("web search failed", err);
			return [];
		}),
	]);

	/*
	 * 읽기 난이도 검색을 **여기서 띄운다.**
	 *
	 * 릴레이는 이 계획을 받아 브라우저가 Gemini 를 부르고, 그 뒤 반영 단계로 돌아온다.
	 * 등급 검색을 반영 단계에 두면 Gemini 가 끝나기를 기다렸다가 다시 25초를 더 기다린다.
	 * 여기서 시작해 두면 브라우저가 Gemini 와 이야기하는 동안 함께 돈다.
	 *
	 * 응답을 붙잡지 않도록 `waitUntil` 에 맡긴다. 두 번 찾는 일은 없다 — 검색 전에 세우는
	 * 표시가 자물쇠 노릇을 한다(`claimReadingLevelSearch`).
	 */
	ctx.waitUntil(
		book.ensureReadingLevel(env, userId, row).catch((err: unknown) => {
			console.warn("reading level lookup failed", err);
		}),
	);

	/*
	 * Tavily 가 넉넉히 물어다 주었으면 내장 검색을 켜지 않는다(서버 경로와 같은 규칙).
	 *
	 * 릴레이에서 특히 크다 — 무료 등급 Gemini 키는 내장 검색에 429 를 내고, 브라우저는 그걸
	 * 보고 검색 없이 한 번 더 부른다. 즉 **호출 하나를 통째로 버린다.** 켜지 않으면 그 왕복이
	 * 아예 없다.
	 */
	const grounded = book.hasTavilyGrounding(row.title, web);

	return {
		...buildGeminiCall(
			buildResearchRequest(
				model,
				{
					title: row.title,
					author: row.author ?? "",
					publisher: row.publisher ?? "",
					isbn: row.isbn13 ?? row.isbn10 ?? "",
					bib,
					web,
					// 서버 경로와 같다 — 다시 찾기면 지난 줄거리를 지우지 말고 보강하게 한다.
					knownPlot: book.knownPlot(row),
				},
				useWebSearch && !grounded,
			),
		),
		model,
		modelNotice,
	};
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
	// 모델이 sources 를 비워 보내도 제공자가 알려준 참고 페이지는 남는다.
	const groundingSources = extractGroundingSources(response as never);
	const { model } = await settings.getRuntime(env, userId);

	/*
	 * 근거가 있는지는 **서버가 다시 판단한다.** 브라우저는 "내장 검색을 켜고 불렀는가" 만
	 * 알지, Tavily 발췌가 프롬프트에 실렸는지는 모른다. 그 자료가 있으면 내장 검색을 켜지
	 * 않았어도 근거는 있는 것이고, 겁주는 안내를 띄울 이유가 없다.
	 */
	const row = await book.requireOwned(env, userId, bookId);
	const grounded = groundingUsed || book.hasTavilyGrounding(row.title, book.cachedWeb(row));

	return book.applyResearch(env, userId, bookId, normalizeResearch(raw), {
		groundingUsed: grounded,
		searchNotice: grounded
			? null
			: "이 키로는 웹 검색을 쓸 수 없어 모델이 아는 지식으로 정리했습니다. 책 정보를 꼭 직접 확인해 주세요.",
		modelNotice: null,
		model,
		groundingSources,
	});
}

/* ── 3. 문제 생성 ────────────────────────────────────── */

/**
 * 릴레이가 한 번에 보낼 요청 수.
 *
 * **1 이다. 즉 릴레이는 나누지 않는다.** 서버 경로(OpenAI·Vertex)는 셋으로 나누는데
 * 여기만 다른 이유는 실측이다.
 *
 * 2026-08-18, Gemini 무료 등급 키 · `gemini-3.6-flash` · 20문항:
 *
 *     한 덩어리로            생성 82초 → 전체 207초
 *     셋으로 나눠 동시에      429·503 이 돌아와 재시도·모델 교체로 번짐.
 *                            198초에도 아직 1라운드 생성 중
 *
 * 릴레이는 **부모의 키로 브라우저가 직접** 부른다. 무료 등급 키는 같은 모델에 동시 호출을
 * 못 견디고, 그 429 는 기다려도 풀리지 않아 모델 교체로 이어진다 — 나눠서 아낀 시간보다
 * 잃는 시간이 훨씬 크다.
 *
 * 요청을 배열로 주고받는 구조는 그대로 둔다. 견디는 키(유료 등급)를 가려낼 방법이 생기거나
 * 호출을 시차를 두고 보내는 방식을 붙이면, 이 숫자만 올리면 된다.
 */
const RELAY_MAX_PARALLEL = 1;

export interface GeneratePlan {
	/** 목표를 이미 채웠으면 더 부를 필요가 없다. */
	done: boolean;
	need: number;
	target: number;
	accepted: number;
	/**
	 * 브라우저가 **동시에** 보낼 요청들. 나누는 규칙은 서버 경로와 같다(`generation.planChunks`).
	 *
	 * 한 번에 24문항을 뽑으면 그것만 80초가 걸린다(실측). 출력 토큰을 만드는 시간이 곧
	 * 임계 경로라, 나눠 나란히 부르면 가장 느린 하나만 기다리게 된다.
	 */
	calls?: { url: string; body: unknown }[];
	model?: string;
	modelNotice?: string | null;
}

export async function planGenerate(
	env: AppEnv,
	userId: string,
	quizId: string,
	rejected: { questionText: string; reason: string }[],
	avoid: string[] = [],
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

	const { model, modelNotice } = await chooseModel(env, userId, "text", avoid);
	const hasWeb = await hasWebSource(env, quiz.book_id);

	/*
	 * 여유분을 더한 뒤 몇 번에 나눠 부를지 정한다(`generation.withBuffer` · `planChunks`).
	 * 모델은 한 번만 고른다 — 같은 라운드의 청크가 서로 다른 모델을 쓰면 문항 성격이 갈린다.
	 */
	const chunks = generation.planChunks(generation.withBuffer(need), RELAY_MAX_PARALLEL);
	const calls = chunks.map((count) =>
		buildGeminiCall(
			buildGenerateRequest({
				// 조립에만 쓰므로 실제 호출 경로는 필요 없다.
				provider: null as never,
				apiKey: "",
				model,
				brief,
				count,
				existing: existing.map((q) => q.question_text),
				rejected: rejected.slice(-10),
				briefIsUnverified: !hasWeb,
				language: quiz.language,
			}),
		),
	);

	return {
		done: false,
		// 화면에는 **필요한 수**를 보여준다. 여유분까지 보여주면 부모가 그만큼 저장될 줄 안다.
		need,
		target: quiz.question_count,
		accepted: existing.length,
		calls,
		model,
		modelNotice,
	};
}

export interface ValidatePlan {
	/**
	 * 사후검사를 통과해 검증으로 보낼 문항. 브라우저는 이걸 그대로 accept 단계에 돌려준다.
	 *
	 * 청크를 합치면서 **번호를 다시 매긴 뒤**의 문항이다. 번호는 검수 결과를 문항에 도로
	 * 잇는 열쇠라(각 청크가 1번부터 매겨 온다) 여기서 정한 번호를 끝까지 써야 한다.
	 */
	questions: GeneratedQuestion[];
	rejected: { questionText: string; reason: string }[];
	/** 검증도 나눠서 동시에 부른다. */
	calls?: { url: string; body: unknown }[];
	model?: string;
	modelNotice?: string | null;
}

/**
 * 생성 응답을 받아 **서버가 사후검사를 돌린 뒤** 검증 요청을 만든다.
 * 선택지 중복·근거 누락·제목 노출·기존 문항과의 중복은 여기서 걸러진다(§7·§9·§10).
 */
export async function planValidate(
	env: AppEnv,
	userId: string,
	quizId: string,
	/** 청크마다 하나씩. 브라우저가 동시에 받아 온 생성 응답들이다. */
	responses: unknown[],
	avoid: string[] = [],
): Promise<ValidatePlan> {
	await assertRelayProvider(env, userId);

	const quiz = await quizzesRepo.findOwned(env, userId, quizId);
	if (!quiz) throw notFound("퀴즈를 찾을 수 없습니다.");

	const bookRow = await booksRepo.findOwned(env, userId, quiz.book_id);
	const brief = bookRow?.brief;
	if (!bookRow || !brief) throw invalid("책 정보(Brief)가 없습니다.");

	/*
	 * 청크 응답을 합치고 **번호를 다시 매긴다.** 각 청크가 1번부터 매겨 오므로 그대로 두면
	 * 번호가 겹치고, 그러면 검수 결과가 엉뚱한 문항에 붙는다.
	 *
	 * 하나가 깨져도 나머지로 간다 — 나눈 만큼 실패할 자리도 늘어난다.
	 */
	const merged: GeneratedQuestion[] = [];
	for (const response of responses) {
		try {
			const parsed = parseGenerateContentResponse<{ questions: GeneratedQuestion[] }>(
				"gemini",
				response as never,
			);
			merged.push(...(parsed.questions ?? []));
		} catch (err) {
			console.warn("generate chunk unreadable", err);
		}
	}
	const generated = generation.renumber(merged);

	const existing = await questionsRepo.listActive(env, quizId);
	// 청크 사이의 중복도 여기서 걸린다 — 같은 `seen` 목록에 쌓으며 훑기 때문이다.
	const screened = screen(generated, {
		accepted: existing.map((q) => q.question_text),
		title: bookRow.title,
		author: bookRow.author ?? "",
		brief,
	});

	const rejected = screened.failed.map((failure) => ({
		questionText:
			generated.find((q) => q.questionNumber === failure.questionNumber)?.questionText ?? "",
		reason: failure.reason,
	}));

	if (screened.passed.length === 0) return { questions: [], rejected };

	const { model, modelNotice } = await chooseModel(env, userId, "text", avoid);
	const groups = generation.sliceInto(
		screened.passed,
		Math.ceil(screened.passed.length / Math.max(1, responses.length)),
	);
	const calls = groups.map((questions) =>
		buildGeminiCall(
			buildValidateRequest({
				provider: null as never,
				apiKey: "",
				model,
				brief,
				questions,
				language: quiz.language,
			}),
		),
	);

	return { questions: screened.passed, rejected, calls, model, modelNotice };
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
	/** 검증 청크마다 하나씩. 브라우저가 동시에 받아 온 응답들이다. */
	responses: unknown[],
): Promise<AcceptResult> {
	await assertRelayProvider(env, userId);

	const quiz = await quizzesRepo.findOwned(env, userId, quizId);
	if (!quiz) throw notFound("퀴즈를 찾을 수 없습니다.");

	const bookRow = await booksRepo.findOwned(env, userId, quiz.book_id);
	if (!bookRow) throw notFound("책을 찾을 수 없습니다.");

	/*
	 * 청크 응답을 합친다. 판정은 문항 번호로 이어지므로 순서는 상관없다.
	 * 하나가 깨져도 나머지로 간다 — 판정을 못 받은 문항은 그냥 통과하지 못할 뿐이다.
	 */
	const results: Verdict[] = [];
	for (const response of responses) {
		try {
			const parsed = parseGenerateContentResponse<{ results: Verdict[] }>(
				"gemini",
				response as never,
			);
			results.push(...(parsed.results ?? []));
		} catch (err) {
			console.warn("validate chunk unreadable", err);
		}
	}
	const verdicts = { results };

	const existing = await questionsRepo.listActive(env, quizId);
	// 클라이언트가 보낸 문항을 그대로 믿지 않는다. 구조 규칙은 여기서 다시 확인한다.
	const screened = screen(questions, {
		accepted: existing.map((q) => q.question_text),
		title: bookRow.title,
		author: bookRow.author ?? "",
		brief: bookRow.brief ?? "",
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
		await generation.persistAccepted(env, quizId, accepted);
	}

	const total = existing.length + accepted.length;

	// 서버가 도는 경로는 runGeneration 이 상태를 옮긴다. 릴레이는 여기가 그 자리다.
	// 상태가 DRAFT 에 머물면 "검수 대기" 인 퀴즈를 목록에서 구분할 수 없다.
	if (total > 0) {
		await quizzesRepo.setStatus(
			env,
			quizId,
			"REVIEW",
			total >= quiz.question_count
				? null
				: // 서버 경로와 같은 안내를 쓴다. 근거 부족이 원인이면 "다시 만들기" 가 아니라
					// 책 정보를 보강해야 한다는 것을 부모가 알아야 한다.
					generation.shortfallNotice(quiz.question_count, total, rejected),
		);
	}

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
