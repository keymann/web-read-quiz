import { withModelFallback } from "../ai/fallback";
import { identifyBook, type BookIdentity } from "../ai/vision";
import * as booksRepo from "../repositories/books";
import type { BookRow } from "../repositories/books";
import * as bibliographic from "../search/bibliographic";
import * as tavily from "../search/tavily";
import { research, type BookResearch } from "../search/web";
import { WEB_SECTION } from "./grounding";
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
	aiConfidence: number | null;
	analyzedAt: string | null;
	searchedAt: string | null;
	hasBrief: boolean;
	/** 부모가 직접 적어 둔 줄거리. 화면이 그대로 다시 보여 주고 고칠 수 있게 한다. */
	manualPlot: string | null;
	createdAt: string;
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
	coverUrl: `/api/books/${row.id}/cover`,
	aiConfidence: row.ai_confidence,
	analyzedAt: row.analyzed_at,
	searchedAt: row.searched_at,
	hasBrief: row.brief !== null && row.brief !== "",
	manualPlot: row.manual_plot,
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

/* ── 3. 정보 검색 ────────────────────────────────────── */

export interface SearchResult {
	book: BookView;
	research: BookResearch;
	sourceCount: number;
	readyForQuiz: boolean;
	/** 웹 검색을 실제로 썼는지. false 면 모델이 아는 지식만으로 답한 것이라 근거가 약하다. */
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

	const ai = await settings.getRuntime(env, userId);

	// 공개 서지 API 와 웹 검색은 성격이 다르다. 전자는 서지정보의 기준점, 후자는 줄거리 원천.
	// 여기서 받은 것을 책에 적어 두고, 반영 단계(applyResearch)가 같은 값을 읽는다.
	const bib = await prepareBib(env, userId, row);
	// 웹 자료가 있으면 조사 지시가 "기억으로 정리" 에서 "자료에서 발췌" 로 바뀐다.
	const web = await prepareWeb(env, userId, row);

	const hint = {
		title: row.title,
		author: row.author ?? "",
		publisher: row.publisher ?? "",
		isbn: row.isbn13 ?? row.isbn10 ?? "",
		bib,
		web,
	};

	// 웹 검색을 쓸 수 없는 키가 있다(Gemini 무료 등급). 그 경우 조사 자체를 포기하지 말고
	// 모델이 아는 지식만으로 한 번 더 시도하되, 근거가 약하다는 사실을 부모에게 알린다.
	let groundingUsed = true;
	let searchNotice: string | null = null;
	let found: BookResearch;
	let fellBackFrom: string | null;
	let modelUsed: string;

	const attempt = (useWebSearch: boolean) =>
		withModelFallback(ai.provider, ai.apiKey, ai.model, (model) =>
			research(ai.provider, ai.apiKey, model, hint, useWebSearch),
		);

	try {
		({ value: found, fellBackFrom, modelUsed } = await attempt(true));
	} catch (err) {
		if (!(err instanceof ApiError) || err.code !== "search_unavailable") throw err;

		groundingUsed = false;
		searchNotice = `${err.message} 웹 검색 없이 정리했으니 책 정보를 꼭 직접 확인해 주세요.`;
		({ value: found, fellBackFrom, modelUsed } = await attempt(false));
	}

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

function collectSources(
	bookId: string,
	bib: bibliographic.BibRecord[],
	found: BookResearch,
	notices: {
		groundingUsed: boolean;
		model: string;
		groundingSources?: { url: string; title: string }[];
		/** Tavily 로 찾은 페이지. 부모가 실제로 열어 확인할 수 있는 근거다. */
		webSources?: tavily.WebSource[];
	},
): booksRepo.NewSource[] {
	const sources: booksRepo.NewSource[] = bib.map((record) => ({
		id: newId(),
		bookId,
		source: record.source,
		url: isStorableUrl(record.url) ? record.url : null,
		title: record.title,
		content: record.description,
	}));

	// Tavily 로 찾은 페이지, 모델이 적어 준 출처, 제공자가 알려준 출처를 합친다.
	// 같은 URL 은 한 번만. Tavily 를 앞에 두어 발췌가 있는 쪽이 남게 한다.
	const seen = new Set<string>();
	for (const source of [...(notices.webSources ?? []), ...found.sources, ...(notices.groundingSources ?? [])]) {
		if (!isStorableUrl(source.url) || seen.has(source.url)) continue;
		seen.add(source.url);
		sources.push({
			id: newId(),
			bookId,
			source: "web",
			url: source.url,
			title: source.title,
			content: ("content" in source ? (source.content as string) : "") || "웹 검색으로 참고한 페이지입니다.",
		});
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

	return sources;
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
 * 조사에 쓸 웹 자료. **캐시가 있으면 그것을 쓴다.**
 *
 * 여기가 크레딧을 지키는 장치다. "정보 다시 찾기" 와 재도전 회차 생성은 조사를 다시 돌리지만
 * 책은 그대로다 — 아이가 5번 재도전한다고 웹을 5번 검색할 이유가 없다.
 * 새로 검색하려면 부모가 재검색을 명시적으로 눌러야 한다(`refreshWeb`).
 */
export async function prepareWeb(
	env: AppEnv,
	userId: string,
	row: BookRow,
): Promise<tavily.WebSource[]> {
	const cached = cachedWeb(row);
	if (cached.length > 0) return cached;
	// 아직 한 번도 안 했을 때만 자동으로 한 번 쓴다.
	if (row.web_searches > 0) return [];
	return runWebSearch(env, userId, row);
}

async function runWebSearch(
	env: AppEnv,
	userId: string,
	row: BookRow,
): Promise<tavily.WebSource[]> {
	const found = await tavily.search(env, { title: row.title, author: row.author ?? "" });

	// 빈손이어도 횟수는 센다. 안 세면 자료 없는 책에서 매 조사마다 크레딧을 쓴다.
	await booksRepo.update(env, userId, row.id, {
		web_searches: row.web_searches + 1,
		...(found.length > 0 ? { web_cache: JSON.stringify(found) } : {}),
	});

	return found;
}

/** 웹 자료를 참고 자료 행으로. 재검색과 조사 반영이 같은 모양을 쓰게 한다. */
const webRows = (bookId: string, sources: tavily.WebSource[]): booksRepo.NewSource[] =>
	sources.map((source) => ({
		id: newId(),
		bookId,
		source: "web",
		url: source.url,
		title: source.title,
		content: source.content,
	}));

export interface WebSearchResult {
	sourceCount: number;
	/** 이 책이 웹 검색을 더 쓸 수 있는 횟수. 화면에 그대로 보여준다. */
	searchesLeft: number;
	/** 이달 서비스 전체가 더 쓸 수 있는 크레딧. */
	creditsLeft: number;
	notice: string | null;
}

/**
 * 부모가 누르는 재검색. **크레딧을 쓰는 유일한 사용자 조작**이다.
 *
 * 두 겹으로 막는다 — 책당 횟수(`MAX_SEARCHES_PER_BOOK`)와 월 예산(`MONTHLY_CAP`).
 * 월 예산만으로는 한 부모가 한 책에 수십 번 눌러 전체를 말릴 수 있다.
 */
export async function refreshWeb(
	env: AppEnv,
	userId: string,
	bookId: string,
): Promise<WebSearchResult> {
	const row = await requireOwned(env, userId, bookId);
	if (!row.title || row.title === "(분석 전)") {
		throw invalid("먼저 책 정보를 분석하거나 제목을 입력해 주세요.");
	}
	if (!env.TAVILY_API_KEY) throw invalid("웹 검색을 쓸 수 없습니다.");

	if (row.web_searches >= budget.MAX_SEARCHES_PER_BOOK) {
		throw invalid(
			`이 책의 웹 검색 횟수를 다 썼습니다 (${budget.MAX_SEARCHES_PER_BOOK}회). 줄거리를 직접 적어 주시면 문제를 만들 수 있습니다.`,
		);
	}

	const before = cachedWeb(row);
	const found = await runWebSearch(env, userId, row);
	const updated = await requireOwned(env, userId, bookId);

	// 새 결과가 없으면 이전 캐시를 지우지 않는다(`runWebSearch` 가 덮지 않는다).
	const kept = found.length > 0 ? found : before;

	/*
	 * 찾은 자료를 **참고 자료에도 바로 넣는다.**
	 *
	 * 이걸 빼먹으면 부모는 "20건 찾았습니다" 를 보고 목록은 0건인 화면을 본다(실제로 겪었다).
	 * 참고 자료가 채워지는 곳이 조사 반영(`applyResearch`) 하나뿐이었기 때문이다.
	 *
	 * 웹 행만 갈아 끼운다. 서지 API 로 얻은 행은 이 검색과 무관하므로 건드리지 않는다.
	 */
	if (found.length > 0) {
		const existing = await booksRepo.listSources(env, bookId);
		await booksRepo.replaceSources(env, bookId, [
			...existing
				.filter((s) => s.source !== "web")
				.map((s) => ({
					id: s.id,
					bookId,
					source: s.source,
					url: s.url,
					title: s.title,
					content: s.content,
				})),
			...webRows(bookId, found),
		]);
	}

	return {
		sourceCount: kept.length,
		searchesLeft: Math.max(0, budget.MAX_SEARCHES_PER_BOOK - updated.web_searches),
		creditsLeft: await budget.remaining(env),
		notice:
			found.length > 0
				? null
				: (await budget.remaining(env)) === 0
					? "이달 웹 검색 한도를 다 썼습니다. 다음 달에 다시 시도하거나 줄거리를 직접 적어 주세요."
					: "웹에서 이 책을 다룬 자료를 찾지 못했습니다. 줄거리를 직접 적어 주시면 문제를 만들 수 있습니다.",
	};
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
	const sources = collectSources(bookId, bib, found, { ...notices, webSources });
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
	 * 조사가 성공했을 때만 새 줄거리로 바꾼다. 실패는 **아무것도 하지 않는 것**이 맞다.
	 */
	await booksRepo.update(env, userId, bookId, {
		...merged,
		// 부모가 적어 둔 줄거리는 조사가 성공해도 남긴다. 가장 믿을 만한 출처다.
		...(found.found
			? { brief: buildBrief(row.title, merged, found, bib, row.manual_plot ?? "", webSources) }
			: {}),
		searched_at: new Date().toISOString(),
	});

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

/** 근거가 얇은지. 웹 검색으로 얻은 출처가 이만큼은 있어야 든든하다. */
export const hasWeakEvidence = (evidenceCount: number): boolean =>
	evidenceCount < MIN_SOURCES_FOR_QUIZ;

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
function mergeMetadata(
	row: BookRow,
	bib: bibliographic.BibRecord | null,
	found: BookResearch | null,
): booksRepo.BookFields {
	const pick = (current: string | null, ...candidates: string[]): string | null =>
		current || candidates.find((value) => value.trim() !== "") || null;

	return {
		author: pick(row.author, bib?.author ?? "", found?.author ?? ""),
		publisher: pick(row.publisher, bib?.publisher ?? "", found?.publisher ?? ""),
		isbn13: pick(row.isbn13, bib?.isbn13 ?? "", found?.isbn13 ?? ""),
		published_at: pick(row.published_at, bib?.publishedAt ?? "", found?.publishedAt ?? ""),
		description: pick(row.description, found?.description ?? "", bib?.description ?? ""),
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
		description: row.description ?? "",
		plotSummary: "",
		characters: [],
		keyEvents: [],
		sources: [],
	};

	await booksRepo.update(env, userId, bookId, {
		manual_plot: text || null,
		// 비우면 Brief 도 없앤다. 부모가 지웠는데 그 내용으로 문제가 나오면 안 된다.
		brief: text === "" ? null : buildBrief(row.title, merged, empty, bib, text, cachedWeb(row)),
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
): string {
	/*
	 * 부모가 적은 글도 `[줄거리]` 안에 둔다. 별도 제목을 붙이면 생성 프롬프트가 그것을
	 * 출제 근거 목록(`[줄거리]·[주요 사건]·[등장인물]`)에서 빠뜨린다 — 정작 가장 믿을 만한
	 * 출처인데 근거로 안 쓰이게 된다.
	 */
	const plot = [found.plotSummary.trim(), manualPlot.trim()].filter(Boolean).join("\n");

	const lines = [
		`[책] ${title}`,
		`지은이: ${merged.author ?? "미상"} / 출판사: ${merged.publisher ?? "미상"} / 출간: ${merged.published_at ?? "미상"}`,
		found.targetAge ? `권장 독자: ${found.targetAge}` : "",
		"",
		"[소개]",
		merged.description ?? "",
		"",
		"[줄거리]",
		plot,
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

	if (found.characters.length > 0) {
		lines.push("", "[등장인물]");
		for (const person of found.characters) lines.push(`- ${person.name}: ${person.role}`);
	}

	if (found.keyEvents.length > 0) {
		lines.push("", "[주요 사건 — 일어난 순서]");
		found.keyEvents.forEach((event, index) => lines.push(`${index + 1}. ${event}`));
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
