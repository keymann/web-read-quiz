import { withModelFallback } from "../ai/fallback";
import { detectOrientation, type CoverOrientation } from "../ai/orient";
import { identifyBook, type BookIdentity } from "../ai/vision";
import * as booksRepo from "../repositories/books";
import type { BookRow } from "../repositories/books";
import * as bibliographic from "../search/bibliographic";
import * as tavily from "../search/tavily";
import * as readingLevel from "../search/reading-level";
import { research, type BookResearch } from "../search/web";
import { sectionBody, WEB_SECTION } from "./grounding";
import * as plot from "./plot";
import * as budget from "./search-budget";
import * as settings from "./settings";
import type { AppEnv } from "../types";
import { assertUploadedImage } from "../utils/image";
import { newId } from "../utils/id";
import { ApiError, invalid, notFound } from "../utils/response";

/**
 * 책 등록 → 식별 → 정보 수집 파이프라인(§5·§6).
 *
 * 세 단계를 부모가 각각 확인하며 진행한다. AI 가 표지를 잘못 읽는 일이 흔하므로
 * 중간에 부모가 값을 고칠 수 있어야 하고, 고친 값이 다음 단계 입력이 되어야 한다.
 */

/** 문제를 만들려면 근거가 이만큼은 있어야 한다. AI 가 없는 내용을 지어내는 것을 막는 장치(§리스크). */
export const MIN_SOURCES_FOR_QUIZ = 2;

/**
 * 주요 사건 절의 이름. **적는 쪽과 되읽는 쪽이 같은 값을 봐야 한다** — 어긋나면 옛 행을
 * 되짚을 때 조용히 빈 목록이 된다(`knownEvents`).
 */
const EVENTS_SECTION = "[주요 사건 — 일어난 순서]";

export interface BookView {
	id: string;
	title: string;
	subtitle: string | null;
	author: string | null;
	publisher: string | null;
	isbn10: string | null;
	isbn13: string | null;
	description: string | null;
	publishedAt: string | null;
	coverUrl: string;
	/**
	 * 표지를 똑바로 세우기까지 아직 남은 회전량(시계 방향, 도).
	 *
	 * `null` 이면 아직 확인하지 않았다는 뜻이다 — 화면이 그때 한 번 확인을 걸어 준다.
	 * 0 이 아니면 브라우저가 그만큼 돌려 다시 올려야 한다(회전은 브라우저만 할 수 있다).
	 */
	coverRotation: number | null;
	aiConfidence: number | null;
	analyzedAt: string | null;
	searchedAt: string | null;
	hasBrief: boolean;
	/** 부모가 직접 적어 둔 줄거리. 화면이 그대로 다시 보여 주고 고칠 수 있게 한다. */
	manualPlot: string | null;
	/** 책이 쓰인 언어(ISO 639-1). 화면이 영문책일 때만 읽기 난이도 자리를 만든다. */
	language: string | null;
	/**
	 * 영문책의 읽기 난이도. **하나라도 알아낸 게 있을 때만** 채운다.
	 *
	 * 통째로 null 이면 화면이 "아직 못 찾았다"와 "해당 없다"를 `language` 로 구분한다.
	 */
	readingLevel: ReadingLevelView | null;
	createdAt: string;
}

/** AR·Lexile. 미국 학교에서 쓰는 두 척도이고 영문책에만 존재한다. */
export interface ReadingLevelView {
	/**
	 * 이 값이 어디서 왔는지. `web` 이면 실제 페이지에서 읽은 값, `ai` 면 모델이 짐작한 값.
	 * 화면은 `ai` 일 때 **"AI가 추측한 등급"** 이라고 분명히 적어야 한다.
	 */
	source: "web" | "ai";
	/** ATOS 북 레벨. 4.7 = 4학년 7개월. */
	ar: number | null;
	/** 다 읽었을 때 받는 AR 포인트. 분량에 비례한다. */
	arPoints: number | null;
	/** 흥미 수준 LG · MG · MG+ · UG. */
	arInterest: string | null;
	/** 렉사일 지수. 접두어를 포함한 문자열(620L · AD540L). */
	lexile: string | null;
}

/** 아무것도 못 알아냈으면 null. 화면이 빈 칸만 늘어놓지 않게 한다. */
function readingLevelOf(row: BookRow): ReadingLevelView | null {
	const level = {
		ar: row.ar_level,
		arPoints: row.ar_points,
		arInterest: row.ar_interest,
		lexile: row.lexile,
	};
	if (!Object.values(level).some((v) => v !== null && v !== "")) return null;

	// 출처가 적혀 있지 않은 옛 행은 웹에서 온 것으로 본다 — 짐작은 이 컬럼이 생긴 뒤에만 넣는다.
	return { source: row.reading_level_source ?? "web", ...level };
}

export const toView = (row: BookRow): BookView => ({
	id: row.id,
	title: row.title,
	subtitle: row.subtitle,
	author: row.author,
	publisher: row.publisher,
	isbn10: row.isbn10,
	isbn13: row.isbn13,
	description: row.description,
	publishedAt: row.published_at,
	/*
	 * 주소에 갱신 시각을 붙인다. 표지 바이트가 **같은 키 위에서 바뀌기** 때문이다(회전 보정).
	 * 응답에 `private, max-age=3600` 이 붙어 있어, 주소가 그대로면 브라우저가 한 시간 동안
	 * 돌리기 전 사진을 계속 보여 준다.
	 */
	coverUrl: `/api/books/${row.id}/cover?v=${encodeURIComponent(row.updated_at)}`,
	coverRotation: row.cover_rotation,
	aiConfidence: row.ai_confidence,
	analyzedAt: row.analyzed_at,
	searchedAt: row.searched_at,
	hasBrief: row.brief !== null && row.brief !== "",
	manualPlot: row.manual_plot,
	language: row.book_language,
	readingLevel: readingLevelOf(row),
	createdAt: row.created_at,
});

/* ── 1. 등록 ─────────────────────────────────────────── */

export async function create(
	env: AppEnv,
	userId: string,
	bytes: Uint8Array,
): Promise<BookView> {
	const mime = assertUploadedImage(bytes);

	const bookId = newId();
	// 키에 사용자 id 를 넣어 저장소에서도 소유가 드러나게 한다.
	const key = `books/${userId}/${bookId}`;

	// KV 값 상한은 25MB, 업로드 상한은 8MB 라 여유가 있다.
	// TTL 을 걸지 않는다 — 표지는 책이 남아 있는 동안 계속 필요하다.
	await env.IMAGES.put(key, bytes, { metadata: { contentType: mime } });
	await booksRepo.insert(env, {
		id: bookId,
		createdBy: userId,
		title: "(분석 전)",
		coverKey: key,
		coverMime: mime,
	});

	const row = await booksRepo.findOwned(env, userId, bookId);
	if (!row) throw notFound("책을 등록하지 못했습니다.");
	return toView(row);
}

export async function requireOwned(
	env: AppEnv,
	userId: string,
	bookId: string,
): Promise<BookRow> {
	const row = await booksRepo.findOwned(env, userId, bookId);
	if (!row) throw notFound("책을 찾을 수 없습니다.");
	return row;
}

export async function readCover(
	env: AppEnv,
	userId: string,
	bookId: string,
): Promise<{ body: ReadableStream; mime: string }> {
	const row = await requireOwned(env, userId, bookId);
	if (!row.cover_key) throw notFound("표지 이미지가 없습니다.");

	const body = await env.IMAGES.get(row.cover_key, "stream");
	if (!body) throw notFound("표지 이미지가 없습니다.");

	return { body, mime: row.cover_mime ?? "application/octet-stream" };
}

/**
 * 표지 바이트를 읽는다. AI 에 넘길 때 쓴다.
 *
 * KV 는 쓰기가 전역에 퍼지는 데 시간이 걸린다(eventual consistency). 업로드 직후 분석을
 * 누르면 아직 못 읽는 경우가 드물게 생긴다. 몇 번 짧게 다시 읽어 그 창을 넘긴다.
 */
async function readCoverBytes(env: AppEnv, key: string): Promise<Uint8Array | null> {
	for (let attempt = 1; attempt <= 3; attempt++) {
		const buffer = await env.IMAGES.get(key, "arrayBuffer");
		if (buffer) return new Uint8Array(buffer);
		if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
	}
	return null;
}

/* ── 표지 방향 보정 ─────────────────────────────────── */

export interface OrientResult {
	book: BookView;
	/** 시계 방향으로 더 돌려야 하는 각도. 0 이면 브라우저가 할 일이 없다. */
	rotation: number;
	/** 고른 모델이 응답하지 않아 다른 모델로 처리했을 때의 안내. */
	modelNotice: string | null;
}

/**
 * 표지가 누워 있는지 모델에게 묻는다(§5 등록).
 *
 * **책 한 권에 한 번만 부른다.** `cover_rotation` 이 `null` 인 동안만 확인 대상이고, 한 번
 * 확인하면 결과가 0 이든 90 이든 그 컬럼이 채워져 다시 묻지 않는다. 이미 등록된 책도 같은
 * 길로 한 번씩 지나가게 하려고 컬럼의 기본값을 `null` 로 두었다.
 *
 * 돌리는 일 자체는 여기서 못 한다 — Workers 런타임에는 이미지 디코더가 없다. 그래서 각도만
 * 적어 두고, 브라우저가 그 값을 보고 돌려 다시 올린다(`replaceCover`).
 */
export async function orient(env: AppEnv, userId: string, bookId: string): Promise<OrientResult> {
	const row = await requireOwned(env, userId, bookId);
	if (!row.cover_key) throw invalid("표지 이미지가 없습니다.");

	const bytes = await readCoverBytes(env, row.cover_key);
	if (!bytes) throw invalid("표지 이미지를 찾을 수 없습니다.");

	const ai = await settings.getRuntime(env, userId);
	const image = { bytes, mime: row.cover_mime ?? "image/jpeg" };

	const { value: orientation, fellBackFrom } = await withModelFallback(
		ai.provider,
		ai.apiKey,
		ai.visionModel,
		(model) => detectOrientation(ai.provider, ai.apiKey, model, image),
	);

	return applyOrientation(env, userId, bookId, orientation, noticeFor(fellBackFrom));
}

/**
 * 판정 결과를 책에 적는다. 서버가 모델을 부르든 브라우저가 부르든 **반영 규칙은 여기 하나**다.
 */
export async function applyOrientation(
	env: AppEnv,
	userId: string,
	bookId: string,
	orientation: CoverOrientation,
	modelNotice: string | null = null,
): Promise<OrientResult> {
	await booksRepo.update(env, userId, bookId, { cover_rotation: orientation.rotation });

	return {
		book: toView(await requireOwned(env, userId, bookId)),
		rotation: orientation.rotation,
		modelNotice,
	};
}

/**
 * 브라우저가 돌려 보낸 표지로 갈아 끼운다.
 *
 * 클라이언트가 보낸 바이트를 그대로 믿지 않는다 — 등록할 때와 **같은 검증**을 거친다(§26).
 * 저장이 끝나면 남은 회전량을 0 으로 되돌린다. 그래야 다음에 이 책을 열 때 또 돌리지 않는다.
 *
 * 키는 그대로 쓴다. 새 키를 만들면 예전 바이트가 KV 에 남고, 그것을 지우는 일까지 여기서
 * 챙겨야 한다. 같은 키에 덮어쓰면 그런 뒤처리가 없다.
 */
export async function replaceCover(
	env: AppEnv,
	userId: string,
	bookId: string,
	bytes: Uint8Array,
): Promise<BookView> {
	const row = await requireOwned(env, userId, bookId);
	if (!row.cover_key) throw invalid("표지 이미지가 없습니다.");

	const mime = assertUploadedImage(bytes);
	await env.IMAGES.put(row.cover_key, bytes, { metadata: { contentType: mime } });
	await booksRepo.update(env, userId, bookId, { cover_mime: mime, cover_rotation: 0 });

	return toView(await requireOwned(env, userId, bookId));
}

/* ── 책 지우기 ───────────────────────────────────────── */

/**
 * 부모가 지우는 책. **되돌릴 수 없다.**
 *
 * 문항은 `is_active = 0` 으로 감춰 두는 반면(§21.7·§21.8) 책은 행까지 지운다. 감춤은
 * "이 문제 말고 다른 문제를 내 달라" 는 뜻이지만, 부모가 책장에서 책을 지우는 것은
 * **그 책을 등록한 일 자체를 없애는 것**이다. 잘못 찍은 표지, 남의 책, 아이가 흥미를 잃은
 * 책이 목록에 계속 남으면 책장이 못 쓰게 된다.
 *
 * 그래서 화면은 지우기 전에 무엇이 함께 사라지는지 알려 주고 취소할 기회를 준다.
 * 무엇이 사라지는지는 `booksRepo.remove` 한 곳에 적혀 있다.
 */
export async function remove(env: AppEnv, userId: string, bookId: string): Promise<void> {
	const row = await requireOwned(env, userId, bookId);
	if (!(await booksRepo.remove(env, userId, bookId))) {
		throw notFound("책을 찾을 수 없습니다.");
	}

	/*
	 * 표지는 D1 이 아니라 KV 에 있다. **행을 지운 뒤에** 지운다.
	 *
	 * 순서를 바꾸면 D1 삭제가 실패했을 때 표지 없는 책이 책장에 남는다. 반대로 이 삭제가
	 * 실패하면 아무도 가리키지 않는 바이트가 KV 에 남을 뿐이라, 부모에게 보이는 문제가 없다.
	 */
	if (row.cover_key) await env.IMAGES.delete(row.cover_key);
}

/* ── 2. AI 식별 ──────────────────────────────────────── */

export interface AnalyzeResult {
	book: BookView;
	identity: BookIdentity;
	/** 낮으면 부모에게 직접 확인해 달라고 안내한다. */
	needsReview: boolean;
	/** 고른 모델이 응답하지 않아 다른 모델로 처리했을 때의 안내. */
	modelNotice: string | null;
}

const LOW_CONFIDENCE = 0.6;

export async function analyze(env: AppEnv, userId: string, bookId: string): Promise<AnalyzeResult> {
	const row = await requireOwned(env, userId, bookId);
	if (!row.cover_key) throw invalid("표지 이미지가 없습니다.");

	const bytes = await readCoverBytes(env, row.cover_key);
	if (!bytes) throw invalid("표지 이미지를 찾을 수 없습니다.");

	const ai = await settings.getRuntime(env, userId);

	const image = { bytes, mime: row.cover_mime ?? "image/jpeg" };
	const { value: identity, fellBackFrom } = await withModelFallback(
		ai.provider,
		ai.apiKey,
		ai.visionModel,
		(model) => identifyBook(ai.provider, ai.apiKey, model, image),
	);

	return applyIdentity(env, userId, bookId, identity, noticeFor(fellBackFrom));
}

/**
 * 표지 식별 결과를 책에 반영한다.
 *
 * 서버가 AI 를 부르든 브라우저가 부르든 **반영 규칙은 여기 하나뿐**이다. 빈 제목으로 덮어쓰지
 * 않는 것, AI 원본을 그대로 남기는 것, ISBN 자릿수로 컬럼을 고르는 것이 모두 여기 있다.
 */
export async function applyIdentity(
	env: AppEnv,
	userId: string,
	bookId: string,
	identity: BookIdentity,
	modelNotice: string | null = null,
): Promise<AnalyzeResult> {
	const isbn = bibliographic.normalizeIsbn(identity.isbn);
	await booksRepo.update(env, userId, bookId, {
		// AI 가 제목을 못 읽었으면 기존 값을 유지한다. 빈 제목으로 덮어쓰지 않는다.
		...(identity.title ? { title: identity.title } : {}),
		author: identity.author || null,
		publisher: identity.publisher || null,
		...(bibliographic.isValidIsbn(isbn)
			? isbn.length === 13
				? { isbn13: isbn }
				: { isbn10: isbn }
			: {}),
		// 외부 검색 결과와 구분해 AI 분석 원본을 그대로 남긴다(§6).
		ai_extracted: JSON.stringify(identity),
		ai_confidence: identity.confidence,
		analyzed_at: new Date().toISOString(),
	});

	return {
		book: toView(await requireOwned(env, userId, bookId)),
		identity,
		needsReview: identity.confidence < LOW_CONFIDENCE || identity.title === "",
		modelNotice,
	};
}

/**
 * Tavily 가 이 책을 다룬 자료를 넉넉히 가져왔는가.
 *
 * 넉넉하면 **제공자 내장 웹 검색을 켜지 않는다.** 그 발췌를 이미 프롬프트에 싣고 있어 같은
 * 일을 두 번 하는 셈이고, 내장 검색은 호출당 5~30초를 더 쓴다. 무료 등급 Gemini 키는 내장
 * 검색에 429 를 내므로 실패한 호출 하나를 통째로 버리고 다시 부르게 된다 — 실측에서 조사
 * 화면에 매번 "이 키로는 웹 검색을 쓸 수 없어…" 가 뜬 것이 그 낭비된 호출이다.
 *
 * 기준은 문제를 만들 수 있다고 보는 최소 근거 수와 같게 둔다. 그만큼 모였으면 모델이 기억을
 * 끌어올 필요가 없다.
 */
export const hasTavilyGrounding = (title: string, web: tavily.WebSource[]): boolean =>
	tavily.relevantCount(web, title) >= MIN_SOURCES_FOR_QUIZ;

/* ── 3. 정보 검색 ────────────────────────────────────── */

export interface SearchResult {
	book: BookView;
	research: BookResearch;
	sourceCount: number;
	readyForQuiz: boolean;
	/**
	 * 이 답이 **웹 자료에 근거하는지**. Tavily 발췌든 제공자 내장 검색이든 하나라도 있으면 참.
	 * false 면 모델이 아는 지식만으로 답한 것이라 근거가 약하다.
	 */
	groundingUsed: boolean;
	/** 근거가 얇은지. 만들 수는 있지만 검수를 더 꼼꼼히 해야 한다. */
	evidenceWeak: boolean;
	/** 웹 검색을 못 쓴 이유. 부모에게 그대로 보여준다. */
	searchNotice: string | null;
	/** 고른 모델이 응답하지 않아 다른 모델로 처리했을 때의 안내. */
	modelNotice: string | null;
}

export async function search(env: AppEnv, userId: string, bookId: string): Promise<SearchResult> {
	const row = await requireOwned(env, userId, bookId);
	if (!row.title || row.title === "(분석 전)") {
		throw invalid("먼저 책 정보를 분석하거나 제목을 입력해 주세요.");
	}

	/*
	 * 셋을 **한꺼번에 띄운다.** 서로 기다릴 이유가 없는데 줄을 세워 두었었다.
	 *
	 * 공개 서지 API 와 웹 검색은 성격이 다르다 — 전자는 서지정보의 기준점, 후자는 줄거리
	 * 원천이고, 둘 다 같은 책 행만 있으면 된다. 여기서 받은 것을 책에 적어 두고 반영
	 * 단계(applyResearch)가 같은 값을 읽는다.
	 *
	 * 서지 조회는 최대 8초, Tavily 는 basic+advanced 로 최대 50초다. 줄을 세우면 그 합을
	 * 기다리지만 나란히 두면 둘 중 긴 쪽만 기다린다. 각자 다른 컬럼에 쓰므로 겹쳐도 안전하다.
	 */
	/*
	 * 둘 다 **보조 단계라 실패해도 조사는 계속한다.** 그래서 각자 자기 실패를 삼킨다.
	 *
	 * 삼키지 않으면 나란히 돌릴 때 한쪽이 거부되는 순간 `Promise.all` 이 곧바로 끝나면서
	 * 다른 쪽 거부가 갈 곳을 잃는다(unhandled rejection). 줄을 세워 두었을 때는 없던 일이다.
	 * AI 키 조회는 다르다 — 키가 없으면 조사를 할 수 없으므로 그대로 올린다.
	 */
	const [ai, bib, web] = await Promise.all([
		settings.getRuntime(env, userId),
		prepareBib(env, userId, row).catch((err: unknown) => {
			console.warn("bibliographic lookup failed", err);
			return [] as bibliographic.BibRecord[];
		}),
		// 웹 자료가 있으면 조사 지시가 "기억으로 정리" 에서 "자료에서 발췌" 로 바뀐다.
		prepareWeb(env, userId, row).catch((err: unknown) => {
			console.warn("web search failed", err);
			return [] as tavily.WebSource[];
		}),
	]);

	const hint = {
		title: row.title,
		author: row.author ?? "",
		publisher: row.publisher ?? "",
		isbn: row.isbn13 ?? row.isbn10 ?? "",
		bib,
		web,
		// 다시 찾기면 지난 정리를 지우지 말고 보강하게 한다. 셋을 함께 준다 — 사건 순서를
		// 제자리에 놓으려면 지난 사건과 새 사건을 한 번에 봐야 한다.
		knownPlot: knownPlot(row),
		knownCharacters: knownCharacters(row),
		knownEvents: knownEvents(row),
	};

	// 웹 검색을 쓸 수 없는 키가 있다(Gemini 무료 등급). 그 경우 조사 자체를 포기하지 말고
	// 모델이 아는 지식만으로 한 번 더 시도하되, 근거가 약하다는 사실을 부모에게 알린다.
	// Tavily 가 충분히 물어다 주었으면 내장 검색은 켜지 않는다.
	const tavilyGrounded = hasTavilyGrounding(row.title, web);

	let groundingUsed = true;
	let searchNotice: string | null = null;
	let found: BookResearch;
	let fellBackFrom: string | null;
	let modelUsed: string;

	/*
	 * 읽기 난이도 검색을 **조사와 나란히** 띄운다.
	 *
	 * 등급 검색은 조사 결과를 전혀 쓰지 않는다(제목·저자만 있으면 된다). 조사 뒤에 두면
	 * 최대 25초를 그냥 더 기다리게 된다. 실패해도 조사를 무너뜨리지 않도록 여기서 삼킨다 —
	 * 등급을 못 찾은 것은 책 정보를 못 찾은 것과 다른 일이다.
	 */
	const levelWork = ensureReadingLevel(env, userId, row).catch((err: unknown) => {
		console.warn("reading level lookup failed", err);
	});

	const attempt = (useWebSearch: boolean) =>
		withModelFallback(ai.provider, ai.apiKey, ai.model, (model) =>
			research(ai.provider, ai.apiKey, model, hint, useWebSearch),
		);

	try {
		({ value: found, fellBackFrom, modelUsed } = await attempt(!tavilyGrounded));
	} catch (err) {
		if (!(err instanceof ApiError) || err.code !== "search_unavailable") throw err;

		// 내장 검색이 막혔다. Tavily 자료가 있으면 근거는 여전히 있으므로 겁주지 않는다.
		groundingUsed = tavilyGrounded;
		searchNotice = tavilyGrounded
			? null
			: `${err.message} 웹 검색 없이 정리했으니 책 정보를 꼭 직접 확인해 주세요.`;
		({ value: found, fellBackFrom, modelUsed } = await attempt(false));
	}

	// 조사가 도는 동안 끝났을 것이다. 여기서 만나야 아래에서 읽는 책 행에 등급이 들어 있다.
	await levelWork;

	return applyResearch(env, userId, bookId, found, {
		groundingUsed,
		searchNotice,
		modelNotice: noticeFor(fellBackFrom),
		model: modelUsed,
	});
}

/**
 * 이 책 정보가 **어디서 왔는지** 남긴다.
 *
 * 부모가 문제를 검수하려면 근거를 볼 수 있어야 한다. 그런데 실제로 겪어 보니 참고 자료가
 * 통째로 비는 경우가 잦았다 — 서지 API 가 한국 아동서를 모르고, 무료 등급 키는 웹 검색을
 * 쓸 수 없고, 검색을 쓴 경우에도 모델이 `sources` 를 자주 비워서 보낸다.
 *
 * 그래서 얻은 것이 적어도 **출처는 반드시 남긴다.** 웹 근거가 하나도 없었다는 사실 자체가
 * 부모가 알아야 할 정보다("이건 모델 기억에서 나온 내용이다").
 */
/**
 * 저장해도 되는 출처 주소인지.
 *
 * 이 URL 은 AI 응답과 외부 서지 API 에서 온다 — 우리가 만든 값이 아니다. `javascript:` 같은
 * 스킴이 섞여 들어오면 부모 화면에 그대로 링크로 붙는다. 화면도 같은 검사를 하지만(`ui.js`),
 * **이미 저장된 값은 화면 검사만으로 지워지지 않으므로** 들어올 때 막는 편이 확실하다.
 */
const isStorableUrl = (url: string | null): url is string =>
	typeof url === "string" && /^https?:\/\//i.test(url.trim());

/**
 * 목록에 쌓아 둘 자료의 수.
 *
 * 다시 찾을 때마다 더하므로 상한이 없으면 부모가 훑을 목록이 한없이 길어진다. 한 번의 검색이
 * 줄거리를 다룬 페이지를 몇 건씩 물어다 주고 책당 크레딧 상한(50)이 검색 횟수를 스무 번쯤으로
 * 묶으므로, 40 은 실제로 닿기 어려운 여유값이다.
 */
const MAX_LISTED_SOURCES = 40;

/**
 * 참고 자료를 늘어놓는 순서 — **카카오 책 → 알라딘 → 웹 검색**.
 *
 * 부모가 근거를 훑는 순서다. 앞의 둘은 서지 데이터베이스로 검증된 정보이고(카카오의 책소개가
 * 알라딘보다 길다 — 실측 250자 대 121자), 웹 검색은 그다음에 참고할 것들이다. 모델의 기억에서
 * 나왔다는 기록은 근거가 아니므로 맨 뒤에 둔다.
 *
 * 목록에 없는 소스는 웹 검색 앞자리에 넣는다 — 서지 API 가 늘어날 때 순서를 다시 정하지
 * 않아도 검증된 정보가 웹보다 앞에 온다.
 */
const SOURCE_ORDER = ["kakao-book", "aladin", "google-books", "open-library", "web", "ai"];
const UNKNOWN_RANK = SOURCE_ORDER.indexOf("web") - 0.5;

const rankOf = (source: string): number => {
	const rank = SOURCE_ORDER.indexOf(source);
	return rank === -1 ? UNKNOWN_RANK : rank;
};

/** 같은 소스끼리는 넣은 순서를 지킨다(`Array.prototype.sort` 는 안정 정렬이다). */
const orderSources = <T extends { source: string }>(sources: T[]): T[] =>
	[...sources].sort((a, b) => rankOf(a.source) - rankOf(b.source));

function collectSources(
	bookId: string,
	title: string,
	found: BookResearch,
	notices: {
		groundingUsed: boolean;
		model: string;
		groundingSources?: { url: string; title: string }[];
		/** Tavily 로 찾은 페이지. 부모가 실제로 열어 확인할 수 있는 근거다. */
		webSources?: tavily.WebSource[];
	},
	/** 이미 목록에 올려 둔 자료. 자리를 지키고 그 뒤에 새것을 붙인다. */
	listed: booksRepo.BookSourceRow[] = [],
): booksRepo.NewSource[] {
	/*
	 * **서지 자료는 참고 자료 목록에 올리지 않는다.**
	 *
	 * 이 목록은 부모가 문제를 검수할 때 **근거를 훑는 곳**이다. 그런데 서지 API 의 책소개는
	 * 홍보 문구라 출제 근거로 인정되지 않는다 — `[출판사 소개]` 는 `EVIDENCE_SECTIONS` 에서
	 * 일부러 빠져 있고(§7), 그것만으로 답할 수 있는 문제는 책을 읽지 않아도 풀린다. 근거가
	 * 아닌 것을 근거 목록에 올려 두면 부모는 읽을 것이 어디 있는지 알 수 없다.
	 *
	 * 웹 자료에 쓰는 줄거리 낱말 검사(`mentionsPlot`)를 여기에 쓰려 했는데 **과했다.** 그
	 * 검사는 상거래 문구가 잔뜩 섞인 긴 페이지를 가르려고 맞춘 것이라, 짧고 밀도 높은 책소개는
	 * 멀쩡한 것도 떨어진다. 실측 — 알라딘의 실제 책소개
	 * "…<나쁜 어린이표>로 아이들만의 생각을 절묘하게 표현해냈던 황선미의 장편동화."
	 * 는 줄거리 낱말이 **0개**다. 홍보 문구인 것은 맞지만 그렇게 걸러낼 대상은 아니다.
	 *
	 * 그래서 낱말로 가리지 않고 **종류로** 가린다. 판정 기준이 하나뿐이라 어긋날 여지가 없다.
	 *
	 * 서지 정보 자체는 계속 쓴다 — 조사 프롬프트에서 **어느 책인지 대조하는 사실**로 들어가고
	 * (`buildResearchRequest` 의 `known`), Brief 의 `[출판사 소개]` 에도 남아 배경이 된다.
	 * 목록에서만 빠진다.
	 */
	const sources: booksRepo.NewSource[] = [];

	/*
	 * Tavily 결과는 **줄거리를 다루는 것만** 올린다.
	 *
	 * 검색은 20건을 물어다 주는데 절반 이상이 판매 페이지·도서관 목록이다. 그것까지 쌓으면
	 * 부모는 정가·배송·장바구니만 적힌 발췌를 스무 개 훑어야 하고, 정작 읽을 것이 어디 있는지
	 * 알 수 없다. 프롬프트에 싣는 자료는 줄이지 않는다 — 거기서는 모델이 대조해 걸러낸다.
	 */
	const web = tavily.plotRelated(notices.webSources ?? [], title);

	/*
	 * **이미 올려 둔 것을 자리째 들고 시작한다.**
	 *
	 * 웹 자료만 들고 온다. 서지 자료는 이 목록에 올리지 않기로 했으므로(위) 옛 행에 남아 있어도
	 * 여기서 되살리지 않는다. `ai` 행은 아래에서 다시 판단한다 — 웹 근거가 생겼으면 그 행은
	 * 더 이상 사실이 아니다.
	 *
	 * 들고 오기 전에 **지금 제목으로 다시 견준다.** 부모가 엉뚱하게 식별된 책의 제목을 고치고
	 * 다시 찾는 길이 있어, 그때 지난 자료는 다른 책 것이 된다. 오래된 근거가 섞이면 부모는
	 * 그것을 이 책의 근거로 읽는다. 목록에 올릴 때 쓰는 것과 같은 자로 본다(`tavily.aboutBook`).
	 */
	const at = new Map<string, number>();
	for (const row of listed) {
		if (row.source !== "web" || !isStorableUrl(row.url) || at.has(row.url)) continue;
		const kept = { url: row.url, title: row.title ?? "", content: row.content ?? "" };
		// 관련도 점수는 검색이 준 값이라 적어 두지 않았다. 제목 대조에는 쓰이지 않는다.
		if (!tavily.aboutBook({ ...kept, score: 0 }, title)) continue;

		at.set(row.url, sources.length);
		sources.push({ id: row.id, bookId, source: "web", ...kept });
	}

	// Tavily 로 찾은 페이지, 모델이 적어 준 출처, 제공자가 알려준 출처를 합친다.
	// 같은 URL 은 한 번만. Tavily 를 앞에 두어 발췌가 있는 쪽이 남게 한다.
	for (const source of [...web, ...found.sources, ...(notices.groundingSources ?? [])]) {
		if (!isStorableUrl(source.url)) continue;
		const content = ("content" in source ? (source.content as string) : "") || "웹 검색으로 참고한 페이지입니다.";

		const kept = at.get(source.url);
		if (kept !== undefined) {
			// 같은 주소면 **자리를 지키고 발췌만 새로 받은 것으로 바꾼다.** 그동안 페이지가
			// 늘어났을 수 있고, 부모가 "세 번째 자료" 로 짚어 둔 자리는 그대로 남아야 한다.
			sources[kept] = { ...sources[kept]!, title: source.title, content };
			continue;
		}

		// 자리가 다 찼으면 붙이지 않는다. 올려 둔 것을 밀어내지는 않는다 — 부모가 이미 읽은 것이다.
		if (sources.length >= MAX_LISTED_SOURCES) continue;

		at.set(source.url, sources.length);
		sources.push({ id: newId(), bookId, source: "web", url: source.url, title: source.title, content });
	}

	/*
	 * 이번 조사가 빈손이면 **지난번에 남긴 기록을 그대로 둔다.**
	 *
	 * Brief 는 그때 정리한 것이 그대로 남아 있으므로(위), 그것이 어디서 나왔는지 적어 둔 줄도
	 * 함께 남아야 앞뒤가 맞는다. 지우면 부모는 근거 없는 Brief 를 보게 된다.
	 */
	if (!found.found && !sources.some((s) => s.source === "web")) {
		for (const row of listed) {
			if (row.source !== "ai") continue;
			sources.push({ id: row.id, bookId, source: "ai", url: null, title: row.title, content: row.content });
		}
	}

	// 웹 근거가 하나도 없으면, 이 내용이 모델의 기억에서 나왔다는 것을 남긴다.
	// 참고 자료가 비어 있는 것과 "근거가 이것뿐"인 것은 부모에게 전혀 다른 정보다.
	if (found.found && !sources.some((s) => s.source === "web")) {
		sources.push({
			id: newId(),
			bookId,
			source: "ai",
			url: null,
			title: `AI 모델이 알고 있는 내용 · ${notices.model}`,
			content: notices.groundingUsed
				? "웹 검색을 했지만 참고할 만한 페이지를 찾지 못해, 모델이 알고 있는 내용으로 정리했습니다."
				: "이 키로는 웹 검색을 쓸 수 없어 모델이 알고 있는 내용으로 정리했습니다.",
		});
	}

	return orderSources(sources);
}

/**
 * 조사에 쓸 서지 정보를 확보한다.
 *
 * 조사 준비(프롬프트 조립)와 반영(병합·출처 적재)이 **같은 값을 봐야 한다.** 두 번 부르면
 * 그 사이에 외부 API 응답이 바뀔 수 있고, 그러면 모델은 A 를 보고 답했는데 서버는 B 로
 * 제목·저자를 덮어쓴다. 한 번 받은 것을 책에 적어 두고 반영 단계가 그것을 읽는다.
 *
 * 릴레이 경로에서는 준비와 반영이 서로 다른 HTTP 요청이라 메모리로 넘길 방법이 없다.
 */
export async function prepareBib(
	env: AppEnv,
	userId: string,
	row: BookRow,
): Promise<bibliographic.BibRecord[]> {
	const bib = await bibliographic.lookup(env, {
		isbn: row.isbn13 ?? row.isbn10 ?? "",
		title: row.title,
		author: row.author ?? "",
		publisher: row.publisher ?? "",
	});

	await booksRepo.update(env, userId, row.id, { bib_cache: JSON.stringify(bib) });
	return bib;
}

/* ── 웹 검색 (Tavily) ───────────────────────────────── */

/** 적어 둔 웹 검색 결과만 읽는다. 크레딧을 쓰지 않는다. */
export function cachedWeb(row: BookRow): tavily.WebSource[] {
	if (!row.web_cache) return [];
	try {
		const parsed: unknown = JSON.parse(row.web_cache);
		return Array.isArray(parsed) ? (parsed as tavily.WebSource[]) : [];
	} catch {
		return [];
	}
}

/**
 * 이번 조사에서 웹 자료를 **새로 찾을 차례인가.**
 *
 * 웹 검색은 **부모가 "정보 다시 찾기" 를 누를 때만** 일어난다. 이 함수를 지나는 길이 조사
 * 하나뿐이고(`search` · `relay.planResearch`), 그 조사를 시작하는 것은 그 버튼뿐이다.
 * 아이의 재도전은 이미 만들어 둔 Brief 로 문항만 채우므로 여기까지 오지 않는다.
 *
 * 누른 것이 **다시 찾기인지는 두 시각을 견주어** 안다. 마지막 조사(`searched_at`)보다 웹
 * 검색(`web_searched_at`)이 새것이면 이번 조사에서 이미 찾은 것이다.
 *
 * 이 비교가 필요한 이유는 버튼 한 번이 조사 계획을 여러 번 세울 수 있기 때문이다.
 *
 *   * 릴레이는 모델이 응답하지 않으면 다른 모델로 계획을 다시 받는다
 *   * 무료 등급 Gemini 키는 내장 검색에 429 를 내서, 검색을 끄고 계획을 다시 받는다
 *
 * 그때마다 검색하면 부모가 버튼을 한 번 눌렀는데 크레딧이 두세 번 나간다.
 */
const shouldSearchWeb = (row: BookRow): boolean => {
	// 책당 크레딧을 다 썼으면 더 찾지 않는다. 찾아 둔 자료로 간다.
	if (row.web_credits >= budget.MAX_CREDITS_PER_BOOK) return false;
	// 아직 한 번도 조사하지 않은 책. 첫 조사는 늘 한 번 찾는다.
	if (row.searched_at === null) return row.web_searches === 0;
	// 이번 조사에서 이미 찾았다.
	return !(row.web_searched_at !== null && row.web_searched_at > row.searched_at);
};

/**
 * 조사에 쓸 웹 자료.
 *
 * 새로 찾을 차례가 아니면 적어 둔 것을 쓴다. 찾을 차례면 찾아서 **모아 둔 것에 더해**
 * 돌려준다(`runWebSearch`) — 이번 질의가 못 건졌다고 지난번에 건진 근거를 버릴 이유가 없다.
 */
export async function prepareWeb(
	env: AppEnv,
	userId: string,
	row: BookRow,
): Promise<tavily.WebSource[]> {
	if (!shouldSearchWeb(row)) return cachedWeb(row);
	return runWebSearch(env, userId, row);
}

/**
 * 지금까지 쌓아 둔 줄거리. 조사를 다시 돌릴 때 모델에게 되돌려 주고, 새 결과를 여기에 더한다.
 *
 * 이걸 안 넘기면 다시 찾기가 지난 줄거리를 통째로 새 결과로 갈아 끼운다. 이번 자료가 지난
 * 자료보다 얇으면 줄거리가 오히려 짧아진다 — 부모가 다시 찾기를 누른 뜻과 반대다.
 *
 * 자료를 모아 두므로(위) 지난 줄거리의 근거가 된 페이지도 프롬프트에 그대로 남아 있다.
 * 그래서 "자료에 있는 것만" 이라는 요구를 지키면서 보강할 수 있다.
 *
 * `ai_plot` 이 빈 **옛 행**은 `brief` 의 `[줄거리]` 에서 되살린다. 그 절에는 부모가 적은
 * 줄거리가 뒤에 붙어 있으므로(`buildBrief`) 그만큼 떼어낸다 — 떼지 않으면 부모 글이 AI 가
 * 쌓은 글에 섞여 들어가, 부모가 자기 글을 고쳐도 옛 문장이 영영 남는다.
 */
export const knownPlot = (row: BookRow): string => {
	const pooled = (row.ai_plot ?? "").trim();
	if (pooled !== "") return pooled;

	const section = row.brief ? sectionBody(row.brief, "[줄거리]") : "";
	const manual = (row.manual_plot ?? "").trim();
	return manual !== "" && section.endsWith(manual)
		? section.slice(0, section.length - manual.length).trim()
		: section;
};

/**
 * 지금까지 쌓아 둔 등장인물. 조사를 다시 돌릴 때 모델에게 되돌려 주고 새 결과를 더한다.
 *
 * 컬럼이 빈 **옛 행**은 `brief` 의 `[등장인물]` 절을 되짚는다. 그 절은 `buildBrief` 가
 * `- 이름: 역할` 꼴로 적어 두므로 되읽을 수 있다.
 */
export const knownCharacters = (row: BookRow): plot.Character[] => {
	const stored = parseJson<plot.Character[]>(row.ai_characters);
	if (stored && stored.length > 0) return stored;

	return sectionBody(row.brief ?? "", "[등장인물]")
		.split("\n")
		.map((line) => line.replace(/^-\s*/, "").trim())
		.filter((line) => line !== "")
		.map((line) => {
			const at = line.indexOf(":");
			return at === -1
				? { name: line, role: "" }
				: { name: line.slice(0, at).trim(), role: line.slice(at + 1).trim() };
		})
		.filter((person) => person.name !== "");
};

/**
 * 지금까지 쌓아 둔 주요 사건. 옛 행은 `[주요 사건 — 일어난 순서]` 절의 번호 목록을 되짚는다.
 */
export const knownEvents = (row: BookRow): string[] => {
	const stored = parseJson<string[]>(row.ai_events);
	if (stored && stored.length > 0) return stored;

	return sectionBody(row.brief ?? "", EVENTS_SECTION)
		.split("\n")
		.map((line) => line.replace(/^\d+\.\s*/, "").trim())
		.filter((line) => line !== "");
};

/** 적어 둔 JSON 을 읽는다. 깨져 있으면 없는 것으로 본다 — 조사를 실패시킬 일이 아니다. */
function parseJson<T>(raw: string | null): T | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as T) : null;
	} catch {
		return null;
	}
}

/**
 * 지금까지 쌓아 둔 책 내용. 조사가 돌 때마다 여기에 더해지고, 그대로 Brief 가 된다.
 *
 * 세 값을 함께 들고 다닌다 — 한 조사가 함께 돌려주고 함께 Brief 에 실리므로 따로 흐르면
 * 한쪽만 갱신되는 일이 생긴다.
 */
export interface Pooled {
	plot: string;
	characters: plot.Character[];
	events: string[];
}

/** 조사가 무엇이든 찾아 두었는가. 하나라도 있으면 Brief 를 없애지 않는다. */
export const hasPooled = (pooled: Pooled): boolean =>
	pooled.plot !== "" || pooled.characters.length > 0 || pooled.events.length > 0;

/** 책에 적어 둔 것을 그대로 읽는다. 새로 조사하지 않는다. */
export const pooledOf = (row: BookRow): Pooled => ({
	plot: knownPlot(row),
	characters: knownCharacters(row),
	events: knownEvents(row),
});

async function runWebSearch(
	env: AppEnv,
	userId: string,
	row: BookRow,
): Promise<tavily.WebSource[]> {
	/*
	 * 지금까지 쓴 횟수를 그대로 넘긴다. `tavily.search` 가 그것으로 **다른 질의를 고른다.**
	 *
	 * 이걸 넘기지 않으면 부모가 "웹 자료 다시 찾기" 를 여섯 번 눌러도 똑같은 질의가 여섯 번
	 * 나가 같은 결과를 받아 온다 — 크레딧만 쓰고 근거는 늘지 않는다.
	 */
	const { sources: found, credits } = await tavily.search(
		env,
		{ title: row.title, author: row.author ?? "", publisher: row.publisher ?? "" },
		row.web_searches,
	);

	/*
	 * 찾아 둔 자료에 **더한다.** 갈아 끼우지 않는다.
	 *
	 * 질의 사다리가 시도마다 다른 말로 물으므로 검색마다 걸리는 페이지가 다르다. 새것으로
	 * 덮으면 지난번에 건진 독후감을 잃고, 그만큼 줄거리를 정리할 밑감이 줄어든다. 부모가
	 * 다시 찾기를 누르는 뜻은 "더 모아 달라" 이다.
	 */
	const pooled = tavily.merge(cachedWeb(row), found);

	// 빈손이어도 횟수와 시각은 남긴다. 안 남기면 자료 없는 책에서 같은 조사가 크레딧을
	// 두 번 쓴다(모델 교체·내장 검색 429 로 조사 계획을 다시 세울 때).
	//
	// 크레딧은 **실제로 잡은 값**을 더한다. 깊이로 짐작하면 어긋난다 — 키가 소진돼 다음 키로
	// 넘어가면 그만큼 더 잡고, 예산이 바닥나 한 번도 못 부르면 0 이다.
	await booksRepo.update(env, userId, row.id, {
		web_searches: row.web_searches + 1,
		web_credits: row.web_credits + credits,
		web_searched_at: new Date().toISOString(),
		...(pooled.length > 0 ? { web_cache: JSON.stringify(pooled) } : {}),
	});

	return pooled;
}

/**
 * 참고 자료 한 건을 지운다.
 *
 * **웹 자료 묶음(`web_cache`)에서도 뺀다.** 목록만 지우면 다음 "정보 다시 찾기" 가 그 묶음에서
 * 그 페이지를 그대로 되살린다 — 목록을 쌓게 만든 규칙(`collectSources`)이 그렇게 동작한다.
 * 부모가 지운 자료가 다시 올라오면 지운 뜻이 없어진다.
 *
 * 이미 만들어 둔 문제와 Brief 는 건드리지 않는다. 그것은 이 자료를 근거로 이미 검수를 거친
 * 결과물이고, 여기서 함께 바꾸면 부모가 자료 한 건을 지우려다 문제까지 잃는다. Brief 의
 * `[웹 자료]` 절은 **다음 조사에서** 이 자료 없이 다시 조립된다.
 */
export async function removeSource(
	env: AppEnv,
	userId: string,
	bookId: string,
	sourceId: string,
): Promise<{ sourceCount: number }> {
	const row = await requireOwned(env, userId, bookId);

	const source = await booksRepo.findSource(env, bookId, sourceId);
	if (!source) throw notFound("참고 자료를 찾을 수 없습니다.");

	await booksRepo.removeSource(env, bookId, sourceId);

	if (source.url !== null) {
		const kept = cachedWeb(row).filter((page) => page.url !== source.url);
		await booksRepo.update(env, userId, bookId, { web_cache: JSON.stringify(kept) });
	}

	const left = await booksRepo.listSources(env, bookId);
	return { sourceCount: left.length };
}

/** 적어 둔 서지 결과만 읽는다. 없으면 빈 배열 — 외부를 부르지 않는다. */
function cachedBib(row: BookRow): bibliographic.BibRecord[] {
	if (!row.bib_cache) return [];
	try {
		const parsed: unknown = JSON.parse(row.bib_cache);
		return Array.isArray(parsed) ? (parsed as bibliographic.BibRecord[]) : [];
	} catch {
		return [];
	}
}

/** 준비 단계가 적어 둔 서지 결과. 없으면(예전에 등록된 책) 그때 새로 받는다. */
async function readBib(
	env: AppEnv,
	userId: string,
	row: BookRow,
): Promise<bibliographic.BibRecord[]> {
	const cached = cachedBib(row);
	return cached.length > 0 ? cached : prepareBib(env, userId, row);
}

/**
 * 조사 결과를 책에 반영한다.
 *
 * 출처 적재, 서지정보 병합, Book Brief 조립이 모두 여기 있다. 브라우저가 AI 를 부른 경우에도
 * 이 규칙을 그대로 거친다 — 클라이언트가 보낸 값을 그대로 저장하지 않는다.
 */
export async function applyResearch(
	env: AppEnv,
	userId: string,
	bookId: string,
	found: BookResearch,
	notices: {
		groundingUsed: boolean;
		searchNotice: string | null;
		modelNotice: string | null;
		/** 실제로 답을 만든 모델. 참고 자료에 출처로 남긴다. */
		model: string;
		/** 제공자가 알려준 "실제로 참고한 페이지". 모델이 sources 를 비워도 여기로 남는다. */
		groundingSources?: { url: string; title: string }[];
	},
): Promise<SearchResult> {
	const row = await requireOwned(env, userId, bookId);
	// 준비 단계가 적어 둔 것을 읽는다. 다시 부르면 프롬프트가 본 값과 달라질 수 있다.
	const bib = await readBib(env, userId, row);

	// 준비 단계가 적어 둔 웹 자료. 여기서 새로 검색하지 않는다 — 크레딧을 두 번 쓰게 된다.
	const webSources = cachedWeb(row);
	/*
	 * 이미 올려 둔 참고 자료를 **함께 넘긴다.** 목록을 갈아 끼우지 않고 더하기 위해서다.
	 *
	 * 부모가 실제로 겪은 것이 이 자리다 — 다시 찾을 때마다 참고 자료 목록이 새로 쓰였다.
	 * 웹 자료 묶음(`web_cache`)은 서버가 쌓지만 그 묶음에는 상한(24건)이 있어 밀려난 자료가
	 * 목록에서 사라지고, 모델이 적어 준 출처와 제공자가 알려준 페이지는 애초에 이번 조사 것만
	 * 남았다. 부모가 지난번에 열어 본 자료가 없어지면 검수를 이어 갈 수 없다.
	 */
	const listed = await booksRepo.listSources(env, bookId);
	const sources = collectSources(bookId, row.title, found, { ...notices, webSources }, listed);
	await booksRepo.replaceSources(env, bookId, sources);

	// 책을 특정하지 못했으면 그 결과의 서지정보를 받아들이지 않는다. 엉뚱한 책의 정보가 섞이면
	// 부모가 알아채기 어렵고, 그대로 문제 생성 입력이 되어 버린다.
	const merged = found.found
		? mergeMetadata(row, bib[0] ?? null, found)
		: mergeMetadata(row, bib[0] ?? null, null);

	/*
	 * 조사가 빈손이어도 **이미 저장돼 있던 줄거리는 지우지 않는다.**
	 *
	 * 예전에는 `found.found` 가 false 면 brief 를 통째로 null 로 덮었다. 그러면 잘 되던 책도
	 * "정보 다시 찾기" 한 번에 줄거리를 잃고 문제 만들기 버튼이 잠긴다. 모델이 한 번 빈손으로
	 * 돌아오는 것은 흔한 일이라(무료 등급·과부하·잘 안 알려진 책) 실제로 겪게 된다.
	 *
	 * 조사가 성공했을 때만 줄거리를 손댄다. 실패는 **아무것도 하지 않는 것**이 맞다.
	 */
	/*
	 * 성공했을 때도 갈아 끼우지 않고 **쌓는다.** 줄거리·등장인물·사건 셋 모두.
	 *
	 * 조사 프롬프트가 지난 정리를 되돌려 주며 "지우지 말고 보강하라" 고 시키지만, 모델은 그
	 * 말을 자주 흘린다 — 다시 찾을 때마다 줄거리가 통째로 새 것으로 갈렸다. 부모가 그 버튼을
	 * 누른 뜻은 "더 모아 달라" 이므로, 지키는 일을 부탁이 아니라 서버가 맡는다.
	 *
	 * 셋을 함께 쌓아야 한다 — 하나만 쌓으면 줄거리에 나오는 인물이 목록에서 빠진다.
	 */
	const kept = pooledOf(row);
	const pooled: Pooled = {
		plot: plot.mergePlot(kept.plot, found.plotSummary),
		characters: plot.mergeCharacters(kept.characters, found.characters),
		events: plot.mergeEvents(kept.events, found.keyEvents),
	};
	/*
	 * 읽기 난이도를 **여기서 기다리지 않고 먼저 띄운다.** 조사 결과를 책에 적는 일과
	 * 서로 아무 상관이 없어, 순서대로 하면 그만큼 부모가 더 기다린다.
	 *
	 * 서버 경로는 이미 조사와 나란히 돌려 두었으므로 여기서는 표시를 보고 바로 끝난다.
	 * 값이 있는 쪽은 브라우저 릴레이 경로다 — 거기서는 이 자리가 처음이다.
	 */
	const levelWork = ensureReadingLevel(env, userId, row).catch((err: unknown) => {
		console.warn("reading level lookup failed", err);
	});

	await booksRepo.update(env, userId, bookId, {
		...merged,
		// 부모가 적어 둔 줄거리는 조사가 성공해도 남긴다. 가장 믿을 만한 출처다.
		...(found.found
			? {
					ai_plot: pooled.plot,
					ai_characters: JSON.stringify(pooled.characters),
					ai_events: JSON.stringify(pooled.events),
					brief: buildBrief(row.title, merged, found, bib, row.manual_plot ?? "", webSources, pooled),
				}
			: {}),
		searched_at: new Date().toISOString(),
	});

	// 화면이 등급을 바로 볼 수 있게 여기서 만난다. 위의 저장과 겹쳐 돌았다.
	await levelWork;

	/*
	 * 웹 조회가 끝난 **뒤에** 판단해야 한다. 먼저 짐작해 넣으면 확인된 값이 들어올 자리를
	 * 짐작이 차지한다. 그래서 방금 갱신된 행을 다시 읽고 나서 정한다.
	 */
	if (found.found) {
		await guessReadingLevel(env, userId, await requireOwned(env, userId, bookId), found);
	}

	const updated = await requireOwned(env, userId, bookId);

	return {
		book: toView(updated),
		research: found,
		sourceCount: sources.length,
		readyForQuiz: isReadyForQuiz(updated.brief),
		evidenceWeak: hasWeakEvidence(evidenceCount(sources)),
		groundingUsed: notices.groundingUsed,
		searchNotice: notices.searchNotice,
		modelNotice: notices.modelNotice,
	};
}

/** 폴백이 일어났을 때만 부모에게 알린다. 조용히 다른 모델을 쓰면 결과 차이를 설명할 수 없다. */
const noticeFor = (fellBackFrom: string | null): string | null =>
	fellBackFrom === null
		? null
		: `${fellBackFrom} 모델이 지금 응답하지 않아 다른 모델로 처리했습니다.`;

/**
 * 문제를 만들 준비가 됐는지 — **판단 기준은 여기 하나뿐이다.**
 *
 * 처음에는 "출처 2건 이상"으로 두었는데, 웹 검색을 쓸 수 없는 키(Gemini 무료 등급)에서는
 * 그 기준을 영영 채울 수 없다. 그래서 실질 전제조건인 **Book Brief 존재**로 통일한다.
 * 퀴즈 생성(`createQuiz`)도 같은 것만 확인한다.
 *
 * 출처가 부족한 것은 "만들 수 없음"이 아니라 "근거가 약함"이다. 그건 `evidenceWeak` 로 따로
 * 알리고, 최종 판단은 문제를 검수하는 부모가 한다(§11).
 *
 * 예전에는 이 판정이 두 곳에 흩어져 서로 달랐다. 검색 직후에는 "만들 수 있다"고 하고
 * 책 화면을 다시 열면 버튼이 잠겨 있었다.
 */
export const isReadyForQuiz = (brief: string | null): boolean => brief !== null && brief.trim() !== "";

/**
 * 근거가 얇은지. **줄거리를 교차 검증할 만큼 모였는가**로 본다.
 *
 * 자료가 하나뿐이면 그것이 틀렸을 때 알아낼 방법이 없다. 독후감은 기억으로 쓰는 글이라
 * 줄거리를 잘못 옮기는 일이 흔하다. 둘이 같은 사건을 말하면 그건 책에 실제로 있는 사건이다.
 *
 * 만들 수 없다는 뜻은 아니다 — 그건 Brief 가 있느냐로만 가른다(`isReadyForQuiz`). 여기서
 * 정하는 것은 부모에게 "더 꼼꼼히 검수하라" 고 말할지다.
 */
export const hasWeakEvidence = (evidenceCount: number): boolean =>
	evidenceCount < tavily.MIN_PLOT_SOURCES;

/**
 * 근거로 셀 수 있는 출처의 수.
 *
 * `ai` 출처는 "이 내용이 모델 기억에서 나왔다" 는 기록이지 근거가 아니다. 그것까지 세면
 * 근거가 하나도 없을 때 오히려 경고가 사라진다.
 */
export const evidenceCount = (sources: { source: string }[]): number =>
	sources.filter((s) => s.source !== "ai").length;

/**
 * 비어 있는 칸만 채운다. 부모가 직접 고쳐 둔 값을 검색 결과가 덮어쓰면 안 된다.
 * 우선순위: 기존 값 > 공개 서지 API > 웹 검색.
 */
/**
 * 이 책이 영문책인가.
 *
 * AR·Lexile 은 영문책에만 매겨지므로, 아닐 때 찾아 나서면 크레딧만 버린다.
 * 조사 모델이 언어를 특정했으면 그것을 믿고, 못 했으면 제목으로 가른다 — 한글이 섞여
 * 있으면 한국책이다. 애매하면 찾아본다(빈손으로 끝나도 1 크레딧이다).
 */
function isEnglishBook(language: string | null, title: string): boolean {
	if (language === "en") return true;
	if (language !== null && language !== "") return false;
	return !/[가-힣]/.test(title);
}

/**
 * 읽기 난이도를 찾아 책에 적는다. 이미 있는 값은 건드리지 않고 **빈 자리만** 메운다.
 *
 * 전용 검색을 쓰는 이유는 `search/reading-level.ts` 머리말에 적어 두었다 — 줄거리를 찾는
 * 질의로는 등급이 적힌 페이지가 결과에 들어오지 않는다.
 *
 * **부르는 쪽이 기다리지 않아도 되게** 스스로 저장까지 한다. 조사(AI)와 나란히 돌리려면
 * 결과를 반환값으로 넘겨받는 것보다 각자 자기 컬럼에 쓰는 편이 얽히지 않는다.
 */
export async function ensureReadingLevel(
	env: AppEnv,
	userId: string,
	row: BookRow,
): Promise<void> {
	if (!isEnglishBook(row.book_language, row.title)) return;
	// 이미 다 찼으면 더 찾을 것이 없다.
	if (row.ar_level !== null && (row.lexile ?? "") !== "") return;

	// 표시를 먼저 세운 쪽만 찾는다. 한 번 찾아본 책은 다시 찾지 않는다 —
	// AR·Lexile 이 아예 없는 책이 흔해서, 그 반복이 크레딧을 그냥 태운다.
	if (!(await booksRepo.claimReadingLevelSearch(env, userId, row.id))) return;

	const { level: found, credits } = await readingLevel.lookup(env, {
		title: row.title,
		author: row.author ?? "",
	});

	const fields: booksRepo.BookFields = {};
	if (row.ar_level === null && found.arLevel !== "") fields.ar_level = Number(found.arLevel);
	if (row.ar_points === null && found.arPoints !== "") fields.ar_points = Number(found.arPoints);
	if (!row.ar_interest && found.arInterestLevel !== "") fields.ar_interest = found.arInterestLevel;
	if (!row.lexile && found.lexile !== "") fields.lexile = found.lexile;

	/*
	 * 이 검색도 책의 크레딧을 쓴다. 예전에는 세지 않았다 — 횟수로 막을 때는 셀 자리가 없었다.
	 * 빈손이어도 더한다. 쓴 것은 쓴 것이다.
	 */
	await booksRepo.update(env, userId, row.id, {
		...fields,
		...(Object.keys(fields).length > 0 ? { reading_level_source: "web" as const } : {}),
		web_credits: row.web_credits + credits,
	});
}

/**
 * 웹에서 못 찾았을 때의 마지막 수단 — **조사 모델이 짐작한 값**을 쓴다.
 *
 * 없는 것보다는 낫다. 부모가 아이에게 맞는 책인지 가늠할 실마리는 되고, AR·Lexile 이 아예
 * 매겨지지 않았거나 잘 알려지지 않은 책이 흔하다. 대신 화면에 **"AI가 추측한 등급"** 이라고
 * 분명히 적어 내보낸다(`reading_level_source = 'ai'`).
 *
 * **섞지 않는다.** 웹에서 하나라도 찾았으면 손대지 않는다 — 한 줄에 확인된 값과 짐작한 값이
 * 섞이면 부모가 어느 쪽이 어느 쪽인지 알 수 없다.
 *
 * 값은 이미 도는 조사 호출에 얹어 받는다. 따로 부르지 않으므로 비용도 지연도 늘지 않고,
 * 서버 경로와 브라우저 릴레이 모두 같은 길을 탄다.
 */
async function guessReadingLevel(
	env: AppEnv,
	userId: string,
	row: BookRow,
	found: BookResearch,
): Promise<void> {
	if (!isEnglishBook(row.book_language ?? found.bookLanguage, row.title)) return;
	// 웹에서 하나라도 건졌으면 그대로 둔다.
	if (row.ar_level !== null || (row.lexile ?? "") !== "") return;

	// `normalizeResearch` 가 이미 형식을 검사해 통과시킨 값이다.
	const fields: booksRepo.BookFields = {};
	if (found.arLevel !== "") fields.ar_level = Number(found.arLevel);
	if (found.arPoints !== "") fields.ar_points = Number(found.arPoints);
	if (found.arInterestLevel !== "") fields.ar_interest = found.arInterestLevel;
	if (found.lexile !== "") fields.lexile = found.lexile;
	if (Object.keys(fields).length === 0) return;

	await booksRepo.update(env, userId, row.id, { ...fields, reading_level_source: "ai" });
}

/**
 * AI 가 표지에서 읽어 넣은 값. **부모가 고친 값과 가려내는 데 쓴다.**
 *
 * `applyIdentity` 가 원본을 그대로 남겨 두기 때문에 지금 칸에 든 값이 그것과 같은지 견줄 수
 * 있다. 같으면 부모가 손대지 않은 것이고, 다르면 부모가 고쳤거나 이미 서지로 확인한 값이다.
 */
function aiRead(row: BookRow): { author: string; publisher: string; isbn: string } {
	const empty = { author: "", publisher: "", isbn: "" };
	if (!row.ai_extracted) return empty;

	try {
		const parsed = JSON.parse(row.ai_extracted) as {
			author?: unknown;
			publisher?: unknown;
			isbn?: unknown;
		};
		const text = (value: unknown): string => (typeof value === "string" ? value : "");
		return {
			author: text(parsed.author),
			publisher: text(parsed.publisher),
			// 저장할 때 자릿수만 남겼으므로 견줄 때도 같은 모양으로 만든다.
			isbn: bibliographic.normalizeIsbn(text(parsed.isbn)),
		};
	} catch {
		return empty;
	}
}

/**
 * 빈 칸을 채우고, **AI 가 짐작한 값은 갱신한다.**
 *
 * 예전에는 값이 들어 있으면 무조건 지켰다. 그래서 AI 가 표지에서 지은이를 잘못 읽으면
 * "정보 다시 찾기" 를 몇 번 눌러도 그 값이 영영 남았다 — 서지 API 가 맞는 값을 물어다 줘도
 * 들어갈 자리가 없었다. 부모가 그것을 알아채고 손으로 고치는 수밖에 없었다.
 *
 * 그래서 셋으로 가른다.
 *
 *   빈 칸                  → 찾은 값으로 채운다
 *   AI 가 표지에서 읽은 값  → 찾은 값으로 **갈아 끼운다** (서지 쪽이 검증된 값이다)
 *   그 밖의 값             → 지킨다. 부모가 고친 값이거나 이미 확인한 값이다
 *
 * 부모가 고친 값을 지키는 것이 이 함수의 가장 중요한 약속이다. 화면의 찾기 버튼이 누르는
 * 순간 입력값을 먼저 저장하므로, 부모가 방금 적어 넣은 값도 여기서 지켜진다.
 */
function mergeMetadata(
	row: BookRow,
	bib: bibliographic.BibRecord | null,
	found: BookResearch | null,
): booksRepo.BookFields {
	const ai = aiRead(row);

	const pick = (
		current: string | null,
		/** 이 칸에 AI 가 넣어 둔 값. 빈 문자열이면 AI 가 넣은 것이 아니다. */
		aiValue: string,
		...candidates: string[]
	): string | null => {
		const candidate = candidates.find((value) => value.trim() !== "") ?? "";
		if (!current) return candidate || null;
		if (aiValue !== "" && current === aiValue) return candidate || current;
		return current;
	};

	/*
	 * 읽기 난이도(ar_*·lexile)는 여기서 다루지 않는다. 조사 모델에게 묻지 않고
	 * `ensureReadingLevel` 이 전용 검색으로 따로 채운다 — 추측한 값이 근거 있는 값을
	 * 밀어내지 않도록 출처를 하나로 둔다.
	 */
	return {
		author: pick(row.author, ai.author, bib?.author ?? "", found?.author ?? ""),
		publisher: pick(row.publisher, ai.publisher, bib?.publisher ?? "", found?.publisher ?? ""),
		isbn13: pick(row.isbn13, ai.isbn, bib?.isbn13 ?? "", found?.isbn13 ?? ""),
		// 아래 셋은 AI 가 표지에서 읽는 값이 아니다. 빈 칸만 채운다.
		published_at: pick(row.published_at, "", bib?.publishedAt ?? "", found?.publishedAt ?? ""),
		description: pick(row.description, "", found?.description ?? "", bib?.description ?? ""),
		book_language: pick(row.book_language, "", found?.bookLanguage ?? ""),
	};
}

/** Brief 에 실을 웹 자료 수. 프롬프트가 매 라운드 실리므로 조심해서 정한다. */
const MAX_BRIEF_WEB = 6;


/** 부모가 적은 줄거리의 최소 길이. 이보다 짧으면 문제를 만들 만한 내용이 안 된다. */
export const MIN_MANUAL_PLOT = 50;
/** 상한. 프롬프트가 한없이 길어지지 않게 한다. */
export const MAX_MANUAL_PLOT = 4_000;

/**
 * 부모가 직접 적은 줄거리를 저장하고 Brief 를 다시 조립한다. **AI 호출이 없다.**
 *
 * AI 가 모르는 책이 실제로 있다 — 실측 『움푹산의 비밀』(크레용하우스)은 서지 조회로
 * 제목·지은이·출판사·출판사 책소개까지 확인됐는데도 조사 모델이 모든 항목을 비워 돌려줬다.
 * 무료 등급 키는 웹 검색도 못 쓰므로 그런 책은 영영 문제를 만들 수 없었다.
 *
 * 출판사 책소개로 대신하지 않는 이유: 그건 홍보 문구라 그것만으로 문제를 만들면 책을 읽지
 * 않아도 풀린다(§7). 반면 부모는 그 책을 손에 들고 있다.
 */
export async function saveManualPlot(
	env: AppEnv,
	userId: string,
	bookId: string,
	plot: string,
): Promise<SearchResult> {
	const row = await requireOwned(env, userId, bookId);
	const text = plot.trim();

	if (text !== "" && text.length < MIN_MANUAL_PLOT) {
		throw invalid(`줄거리를 ${MIN_MANUAL_PLOT}자 이상 적어 주세요. 문제를 만들 만한 내용이 필요합니다.`);
	}
	if (text.length > MAX_MANUAL_PLOT) {
		throw invalid(`줄거리는 ${MAX_MANUAL_PLOT}자까지 넣을 수 있습니다.`);
	}

	/*
	 * 여기서는 서지 조회를 **새로 하지 않는다.** 부모가 적은 글을 저장하는 데 외부 API 세 곳을
	 * 부를 이유가 없다. 아직 조사 전이라 캐시가 비어 있으면 서지 없이 Brief 를 만든다 —
	 * 어차피 부모가 적은 줄거리가 출제 근거다.
	 */
	const bib = cachedBib(row);
	const merged: booksRepo.BookFields = {
		author: row.author,
		publisher: row.publisher,
		published_at: row.published_at,
		description: row.description,
	};

	/*
	 * 조사 결과가 없어도 Brief 를 만들 수 있게 빈 조사 결과를 세운다. 이렇게 두면 나중에
	 * 조사가 성공했을 때와 **같은 조립 규칙**을 탄다 — Brief 형식이 두 벌로 갈리지 않는다.
	 */
	const empty: BookResearch = {
		found: text !== "",
		title: row.title,
		author: row.author ?? "",
		publisher: row.publisher ?? "",
		isbn13: row.isbn13 ?? "",
		publishedAt: row.published_at ?? "",
		targetAge: "",
		bookLanguage: row.book_language ?? "",
		// 등급은 이 경로에서 쓰지 않는다. Brief 조립에만 쓰는 빈 조사 결과다.
		arLevel: "",
		arPoints: "",
		arInterestLevel: "",
		lexile: "",
		description: row.description ?? "",
		plotSummary: "",
		characters: [],
		keyEvents: [],
		sources: [],
	};

	/*
	 * 조사가 쌓아 둔 것은 **여기서도 남긴다.**
	 *
	 * 예전에는 부모가 줄거리를 저장하면 Brief 를 빈 조사 결과로 다시 조립해서, AI 가 찾아 둔
	 * 줄거리·등장인물·사건이 그 순간 사라졌다. 부모가 보태려고 적은 글이 오히려 근거를 깎아냈다.
	 */
	const pooled = pooledOf(row);

	await booksRepo.update(env, userId, bookId, {
		manual_plot: text || null,
		/*
		 * 비우면 Brief 도 없앤다 — 부모가 지웠는데 그 내용으로 문제가 나오면 안 된다.
		 * 다만 AI 가 쌓아 둔 줄거리가 있으면 그것은 남는다. 부모가 지운 것은 자기 글이다.
		 */
		brief:
			text === "" && !hasPooled(pooled)
				? null
				: buildBrief(row.title, merged, empty, bib, text, cachedWeb(row), pooled),
	});

	const updated = await requireOwned(env, userId, bookId);
	const sources = await booksRepo.listSources(env, bookId);

	return {
		book: toView(updated),
		research: empty,
		sourceCount: sources.length,
		readyForQuiz: isReadyForQuiz(updated.brief),
		evidenceWeak: hasWeakEvidence(evidenceCount(sources)),
		groundingUsed: false,
		searchNotice: null,
		modelNotice: null,
	};
}

/**
 * Book Brief — 문제 생성 프롬프트에 그대로 들어갈 컨텍스트(§파이프라인 3단계).
 * 별도 AI 호출 없이 서버에서 조립하고, 재생성 때 재사용한다.
 */
function buildBrief(
	title: string,
	merged: booksRepo.BookFields,
	found: BookResearch,
	bib: bibliographic.BibRecord[] = [],
	/** 부모가 직접 적은 줄거리. 있으면 AI 요약과 함께 `[줄거리]` 안에 들어간다. */
	manualPlot = "",
	/** 웹에서 읽은 페이지. 출제 근거로 인정되는 유일한 외부 글이다. */
	web: tavily.WebSource[] = [],
	/**
	 * 지금까지 쌓아 둔 줄거리·등장인물·사건. **이번 조사 결과가 이미 여기 더해져 있다.**
	 *
	 * 그래서 이 세 절은 `found` 를 보지 않는다 — 보면 이번 조사가 흘린 것을 그대로 잃는다.
	 */
	pooled: Pooled = { plot: "", characters: [], events: [] },
): string {
	/*
	 * 부모가 적은 글도 `[줄거리]` 안에 둔다. 별도 제목을 붙이면 생성 프롬프트가 그것을
	 * 출제 근거 목록(`[줄거리]·[주요 사건]·[등장인물]`)에서 빠뜨린다 — 정작 가장 믿을 만한
	 * 출처인데 근거로 안 쓰이게 된다.
	 *
	 * 부모 글은 **뒤에** 붙인다. 자리가 정해져 있어야 다음 조사가 쌓아 둔 것과 부모 글을 다시
	 * 가려낼 수 있다(`knownPlot` 의 옛 행 되살리기).
	 */
	const plotText = [pooled.plot.trim(), manualPlot.trim()].filter(Boolean).join("\n");

	const lines = [
		`[책] ${title}`,
		`지은이: ${merged.author ?? "미상"} / 출판사: ${merged.publisher ?? "미상"} / 출간: ${merged.published_at ?? "미상"}`,
		found.targetAge ? `권장 독자: ${found.targetAge}` : "",
		"",
		"[소개]",
		merged.description ?? "",
		"",
		"[줄거리]",
		plotText,
	];

	// 출판사·서점이 공개한 책소개. **모델의 기억이 아니라 확인된 글**이라 근거 검사가 인정한다.
	// 이것이 이 서지 연동의 실제 산물이다(§docs/korean-book-api-plan.md).
	//
	// 다만 이건 홍보 문구이지 줄거리가 아니다. §7 은 "소개문만 읽어도 답할 수 있는 문제" 를
	// 금지하므로, 아래 프롬프트에서 출제 근거로 쓰지 말라고 명시한다.
	const blurbs = bib
		.map((record) => record.description.trim())
		.filter((text) => text.length >= 40);

	if (blurbs.length > 0) {
		lines.push("", "[출판사 소개]");
		// 같은 문장이 두 소스에서 오면 한 번만.
		const seen = new Set<string>();
		for (const text of blurbs) {
			const key = text.slice(0, 40);
			if (seen.has(key)) continue;
			seen.add(key);
			lines.push(text);
		}
	}

	if (pooled.characters.length > 0) {
		lines.push("", "[등장인물]");
		for (const person of pooled.characters) lines.push(`- ${person.name}: ${person.role}`);
	}

	if (pooled.events.length > 0) {
		lines.push("", EVENTS_SECTION);
		pooled.events.forEach((event, index) => lines.push(`${index + 1}. ${event}`));
	}

	/*
	 * 웹에서 실제로 읽은 페이지의 글. **이 연동의 산물이 여기 들어온다.**
	 *
	 * `[출판사 소개]` 와 다르다. 그건 홍보 문구라 출제 근거로 쓸 수 없지만(§7), 이것은
	 * 독후감·서평·도서관 자료에서 온 **책 내용에 관한 글**이다. 그래서 출제 근거로 인정하고
	 * (`ai/generate.ts` 의 근거 목록에 들어 있다), 근거 검사도 이 절을 기준으로 본다.
	 *
	 * 소스당 상한을 건다 — Brief 는 문제 생성 프롬프트에 그대로 실리므로 여기서 부풀면
	 * 매 라운드 비용이 늘고 모델이 중간을 흘린다.
	 */
	if (web.length > 0) {
		lines.push("", WEB_SECTION);
		web.slice(0, MAX_BRIEF_WEB).forEach((source, index) => {
			lines.push(`[자료 ${index + 1}] ${source.title}`);
			lines.push(source.content.slice(0, tavily.MAX_EXCERPT));
		});
	}

	if (found.sources.length > 0) {
		lines.push("", "[출처]");
		for (const source of found.sources) lines.push(`- ${source.title} ${source.url}`);
	}

	return lines.filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n");
}
