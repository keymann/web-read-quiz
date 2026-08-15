/**
 * 공개 서지 API 조회.
 *
 * API Key 가 필요 없는 곳만 쓴다. AI 가 표지를 잘못 읽었을 때 이 결과가 기준점이 되어
 * 제목·저자·출판사를 바로잡아 준다. 실패해도 파이프라인을 멈추지 않는다 — 웹 검색이 남아 있다.
 */

export interface BibRecord {
	title: string;
	author: string;
	publisher: string;
	isbn13: string;
	publishedAt: string;
	description: string;
	source: string;
	url: string;
}

const TIMEOUT_MS = 8_000;

/** 숫자만 남긴다. ISBN10 은 그대로, ISBN13 은 13자리. */
export const normalizeIsbn = (raw: string): string => raw.replace(/[^0-9Xx]/g, "").toUpperCase();

export const isValidIsbn = (isbn: string): boolean => isbn.length === 10 || isbn.length === 13;

async function getJson<T>(url: string): Promise<T | null> {
	try {
		const res = await fetch(url, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		// 외부 서비스 장애가 책 등록 전체를 막지 않게 한다.
		return null;
	}
}

interface GoogleBooksResponse {
	items?: {
		volumeInfo?: {
			title?: string;
			subtitle?: string;
			authors?: string[];
			publisher?: string;
			publishedDate?: string;
			description?: string;
			industryIdentifiers?: { type?: string; identifier?: string }[];
		};
	}[];
}

async function fromGoogleBooks(query: string): Promise<BibRecord | null> {
	const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=1&country=KR`;
	const body = await getJson<GoogleBooksResponse>(url);
	const info = body?.items?.[0]?.volumeInfo;
	if (!info?.title) return null;

	const isbn13 =
		info.industryIdentifiers?.find((id) => id.type === "ISBN_13")?.identifier ?? "";

	return {
		title: [info.title, info.subtitle].filter(Boolean).join(" - "),
		author: info.authors?.join(", ") ?? "",
		publisher: info.publisher ?? "",
		isbn13,
		publishedAt: info.publishedDate ?? "",
		description: info.description ?? "",
		source: "google-books",
		url: "https://books.google.com/",
	};
}

interface OpenLibraryResponse {
	[key: string]: {
		title?: string;
		subtitle?: string;
		authors?: { name?: string }[];
		publishers?: { name?: string }[];
		publish_date?: string;
		url?: string;
		notes?: string;
	};
}

async function fromOpenLibrary(isbn: string): Promise<BibRecord | null> {
	const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`;
	const body = await getJson<OpenLibraryResponse>(url);
	const record = body?.[`ISBN:${isbn}`];
	if (!record?.title) return null;

	return {
		title: [record.title, record.subtitle].filter(Boolean).join(" - "),
		author: record.authors?.map((a) => a.name ?? "").filter(Boolean).join(", ") ?? "",
		publisher: record.publishers?.map((p) => p.name ?? "").filter(Boolean).join(", ") ?? "",
		isbn13: isbn.length === 13 ? isbn : "",
		publishedAt: record.publish_date ?? "",
		description: record.notes ?? "",
		source: "open-library",
		url: record.url ?? `https://openlibrary.org/isbn/${isbn}`,
	};
}

/**
 * ISBN 이 있으면 ISBN 으로, 없으면 제목+저자로 조회한다(§5).
 * 두 곳을 동시에 물어보고 먼저 유효한 결과를 우선순위대로 고른다.
 */
export async function lookup(hint: {
	isbn?: string;
	title?: string;
	author?: string;
	publisher?: string;
}): Promise<BibRecord[]> {
	const isbn = hint.isbn ? normalizeIsbn(hint.isbn) : "";

	if (isValidIsbn(isbn)) {
		const [google, openLibrary] = await Promise.all([
			fromGoogleBooks(`isbn:${isbn}`),
			fromOpenLibrary(isbn),
		]);
		return [google, openLibrary].filter((r): r is BibRecord => r !== null);
	}

	const terms = [hint.title, hint.author, hint.publisher].filter(Boolean).join(" ");
	if (terms.trim() === "") return [];

	const google = await fromGoogleBooks(terms);
	return google ? [google] : [];
}
