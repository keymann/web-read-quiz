import { withModelFallback } from "../ai/fallback";
import { identifyBook, type BookIdentity } from "../ai/vision";
import * as booksRepo from "../repositories/books";
import type { BookRow } from "../repositories/books";
import * as bibliographic from "../search/bibliographic";
import { research, type BookResearch } from "../search/web";
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
		modelNotice: noticeFor(fellBackFrom),
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
	const bib = await bibliographic.lookup({
		isbn: row.isbn13 ?? row.isbn10 ?? "",
		title: row.title,
		author: row.author ?? "",
		publisher: row.publisher ?? "",
	});

	const hint = {
		title: row.title,
		author: row.author ?? "",
		publisher: row.publisher ?? "",
		isbn: row.isbn13 ?? row.isbn10 ?? "",
		bib,
	};

	// 웹 검색을 쓸 수 없는 키가 있다(Gemini 무료 등급). 그 경우 조사 자체를 포기하지 말고
	// 모델이 아는 지식만으로 한 번 더 시도하되, 근거가 약하다는 사실을 부모에게 알린다.
	let groundingUsed = true;
	let searchNotice: string | null = null;
	let found: BookResearch;
	let fellBackFrom: string | null;

	const attempt = (useWebSearch: boolean) =>
		withModelFallback(ai.provider, ai.apiKey, ai.model, (model) =>
			research(ai.provider, ai.apiKey, model, hint, useWebSearch),
		);

	try {
		({ value: found, fellBackFrom } = await attempt(true));
	} catch (err) {
		if (!(err instanceof ApiError) || err.code !== "search_unavailable") throw err;

		groundingUsed = false;
		searchNotice = `${err.message} 웹 검색 없이 정리했으니 책 정보를 꼭 직접 확인해 주세요.`;
		({ value: found, fellBackFrom } = await attempt(false));
	}

	const sources: booksRepo.NewSource[] = [
		...bib.map((record) => ({
			id: newId(),
			bookId,
			source: record.source,
			url: record.url,
			title: record.title,
			content: record.description,
		})),
		...found.sources.map((source) => ({
			id: newId(),
			bookId,
			source: "web",
			url: source.url,
			title: source.title,
			content: source.content,
		})),
	];
	await booksRepo.replaceSources(env, bookId, sources);

	// 책을 특정하지 못했으면 그 결과의 서지정보를 받아들이지 않는다. 엉뚱한 책의 정보가 섞이면
	// 부모가 알아채기 어렵고, 그대로 문제 생성 입력이 되어 버린다.
	const merged = found.found
		? mergeMetadata(row, bib[0] ?? null, found)
		: mergeMetadata(row, bib[0] ?? null, null);

	await booksRepo.update(env, userId, bookId, {
		...merged,
		brief: found.found ? buildBrief(row.title, merged, found) : null,
		searched_at: new Date().toISOString(),
	});

	return {
		book: toView(await requireOwned(env, userId, bookId)),
		research: found,
		sourceCount: sources.length,
		readyForQuiz: isReady(found, sources.length, groundingUsed),
		groundingUsed,
		searchNotice,
		modelNotice: noticeFor(fellBackFrom),
	};
}

/** 폴백이 일어났을 때만 부모에게 알린다. 조용히 다른 모델을 쓰면 결과 차이를 설명할 수 없다. */
const noticeFor = (fellBackFrom: string | null): string | null =>
	fellBackFrom === null
		? null
		: `${fellBackFrom} 모델이 지금 응답하지 않아 다른 모델로 처리했습니다.`;

/**
 * 문제를 만들 준비가 됐는지.
 *
 * 웹 검색을 쓴 경우에는 출처 2건 이상을 요구한다. AI 가 없는 내용을 지어내는 것을 막는 기준이다.
 * 웹 검색 자체를 쓸 수 없는 키라면 그 기준을 채울 방법이 없다. 이때는 모델이 "이 책을 확실히 안다"고
 * 답한 경우에만 통과시키되, 근거가 약하다는 사실을 `groundingUsed`·`searchNotice` 로 함께 알린다.
 * 어차피 부모가 문제를 검수하므로(§11) 최종 판단은 사람이 한다.
 */
function isReady(found: BookResearch, sourceCount: number, groundingUsed: boolean): boolean {
	if (!found.found) return false;
	if (!groundingUsed) return found.plotSummary.trim() !== "";
	return sourceCount >= MIN_SOURCES_FOR_QUIZ;
}

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

/**
 * Book Brief — 문제 생성 프롬프트에 그대로 들어갈 컨텍스트(§파이프라인 3단계).
 * 별도 AI 호출 없이 서버에서 조립하고, 재생성 때 재사용한다.
 */
function buildBrief(
	title: string,
	merged: booksRepo.BookFields,
	found: BookResearch,
): string {
	const lines = [
		`[책] ${title}`,
		`지은이: ${merged.author ?? "미상"} / 출판사: ${merged.publisher ?? "미상"} / 출간: ${merged.published_at ?? "미상"}`,
		found.targetAge ? `권장 독자: ${found.targetAge}` : "",
		"",
		"[소개]",
		merged.description ?? "",
		"",
		"[줄거리]",
		found.plotSummary,
	];

	if (found.characters.length > 0) {
		lines.push("", "[등장인물]");
		for (const person of found.characters) lines.push(`- ${person.name}: ${person.role}`);
	}

	if (found.keyEvents.length > 0) {
		lines.push("", "[주요 사건 — 일어난 순서]");
		found.keyEvents.forEach((event, index) => lines.push(`${index + 1}. ${event}`));
	}

	if (found.sources.length > 0) {
		lines.push("", "[출처]");
		for (const source of found.sources) lines.push(`- ${source.title} ${source.url}`);
	}

	return lines.filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n");
}
