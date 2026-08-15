import { identifyBook, type BookIdentity } from "../ai/vision";
import * as booksRepo from "../repositories/books";
import type { BookRow } from "../repositories/books";
import * as bibliographic from "../search/bibliographic";
import { research, type BookResearch } from "../search/web";
import * as settings from "./settings";
import type { AppEnv } from "../types";
import { assertUploadedImage } from "../utils/image";
import { newId } from "../utils/id";
import { invalid, notFound } from "../utils/response";

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
	// 키에 사용자 id 를 넣어 R2 상에서도 소유가 드러나게 한다. 버킷은 비공개다.
	const key = `books/${userId}/${bookId}`;

	await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: mime } });
	await booksRepo.insert(env, {
		id: bookId,
		createdBy: userId,
		title: "(분석 전)",
		coverR2Key: key,
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
	if (!row.cover_r2_key) throw notFound("표지 이미지가 없습니다.");

	const object = await env.IMAGES.get(row.cover_r2_key);
	if (!object) throw notFound("표지 이미지가 없습니다.");

	return { body: object.body, mime: row.cover_mime ?? "application/octet-stream" };
}

/* ── 2. AI 식별 ──────────────────────────────────────── */

export interface AnalyzeResult {
	book: BookView;
	identity: BookIdentity;
	/** 낮으면 부모에게 직접 확인해 달라고 안내한다. */
	needsReview: boolean;
}

const LOW_CONFIDENCE = 0.6;

export async function analyze(env: AppEnv, userId: string, bookId: string): Promise<AnalyzeResult> {
	const row = await requireOwned(env, userId, bookId);
	if (!row.cover_r2_key) throw invalid("표지 이미지가 없습니다.");

	const object = await env.IMAGES.get(row.cover_r2_key);
	if (!object) throw invalid("표지 이미지를 찾을 수 없습니다.");

	const [apiKey, models] = await Promise.all([
		settings.getApiKey(env, userId),
		settings.getModels(env, userId),
	]);

	const identity = await identifyBook(apiKey, models.visionModel, {
		bytes: new Uint8Array(await object.arrayBuffer()),
		mime: row.cover_mime ?? "image/jpeg",
	});

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
	};
}

/* ── 3. 정보 검색 ────────────────────────────────────── */

export interface SearchResult {
	book: BookView;
	research: BookResearch;
	sourceCount: number;
	readyForQuiz: boolean;
}

export async function search(env: AppEnv, userId: string, bookId: string): Promise<SearchResult> {
	const row = await requireOwned(env, userId, bookId);
	if (!row.title || row.title === "(분석 전)") {
		throw invalid("먼저 책 정보를 분석하거나 제목을 입력해 주세요.");
	}

	const [apiKey, models] = await Promise.all([
		settings.getApiKey(env, userId),
		settings.getModels(env, userId),
	]);

	// 공개 서지 API 와 웹 검색은 성격이 다르다. 전자는 서지정보의 기준점, 후자는 줄거리 원천.
	const bib = await bibliographic.lookup({
		isbn: row.isbn13 ?? row.isbn10 ?? "",
		title: row.title,
		author: row.author ?? "",
		publisher: row.publisher ?? "",
	});

	const found = await research(apiKey, models.model, {
		title: row.title,
		author: row.author ?? "",
		publisher: row.publisher ?? "",
		isbn: row.isbn13 ?? row.isbn10 ?? "",
		bib,
	});

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
		readyForQuiz: found.found && sources.length >= MIN_SOURCES_FOR_QUIZ,
	};
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
