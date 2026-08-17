import { groundedRatio } from "../services/grounding";
import type { AppEnv } from "../types";

/**
 * 서지 API 조회.
 *
 * AI 가 표지를 잘못 읽었을 때 이 결과가 기준점이 되어 제목·저자·출판사를 바로잡아 준다.
 * 실패해도 파이프라인을 멈추지 않는다 — 웹 검색이 남아 있다.
 *
 * 국내 도서는 Google Books·Open Library 로 거의 잡히지 않는다(전자는 익명 할당량 소진, 후자는
 * 한국 아동서 데이터 자체가 없음). 그래서 알라딘을 앞에 둔다. 키는 **서비스 공용**이며
 * 없으면 그 소스만 건너뛴다(§docs/korean-book-api-plan.md).
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

/**
 * HTML 엔티티를 되돌린다. `&amp;` 는 **마지막에** — 먼저 풀면 `&amp;lt;` 가 `<` 로 두 번 변환된다.
 */
const decodeEntities = (text: string): string =>
	text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");

/**
 * 알라딘 `description` 에는 **HTML 이 섞여 온다.** 실측 원문:
 *
 * ```
 * <a href="/catalog/book.asp?ISBN=8901028514&UID=<% =qsUID %>">&lt;나쁜 어린이표&gt;</a>로 …
 * ```
 *
 * 태그 안에 ASP 블록(`<% … %>`)이 중첩돼 있다. 그래서 `<[^>]*>` 만 돌리면 그 블록의 `>` 에서
 * 끊겨 `">` 가 남는다 — 실제로 참고 자료에 `">로 아이들만의…` 로 보였다.
 * **ASP 블록을 먼저** 지운 뒤 태그를 지워야 한다.
 */
function stripHtml(raw: string): string {
	return decodeEntities(
		raw
			// 태그 속성 안에 들어앉은 템플릿 블록. 이걸 먼저 치워야 태그 제거가 온전히 된다.
			.replace(/<%[\s\S]*?%>/g, "")
			.replace(/<[^>]*>/g, ""),
	)
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * 검색 결과가 **찾던 그 책인지** 확인한다.
 *
 * ISBN 조회는 정확 조회라 이 검사가 필요 없다. 문제는 제목 검색이다 — 같은 작품도 판본이
 * 여럿이고(실측: 『마당을 나온 암탉』이 반양장·애니메이션 그림책·20주년 기념판) 동명이서도 있다.
 *
 * 다른 책의 책소개가 Brief 에 들어가면 **그 책에 "근거가 있는" 틀린 문항**이 만들어지고
 * 근거 검사(`services/grounding.ts`)가 그것을 통과시킨다. 빈약한 Brief 보다 나쁘다.
 * 그래서 못 맞추면 버린다 — 없는 것이 낫다.
 *
 * 비교는 `groundedRatio` 를 그대로 쓴다. "찾던 낱말이 후보 안에 있는가" 를 어간으로 세는
 * 계산이고, 부제·판본 표기가 후보에만 더 붙는 상황에 정확히 맞는다. 같은 계산을 세 번째로
 * 구현하지 않는다.
 */
const TITLE_MATCH = 0.7;
const PERSON_MATCH = 0.6;

/**
 * 이 후보를 받아들일지.
 *
 * 대조할 제목이 없으면(표지에서 아무것도 못 읽은 경우) 검사할 방법이 없으므로 통과시킨다.
 * 그 상태에서는 조사 단계 자체가 제목을 요구해 진행되지 않는다.
 */
export const accepts = (
	hint: { title?: string; author?: string; publisher?: string },
	record: { title: string; author: string; publisher: string },
): boolean => (hint.title ?? "").trim() === "" || isSameBook(hint, record);

export function isSameBook(
	hint: { title?: string; author?: string; publisher?: string },
	found: { title: string; author: string; publisher: string },
): boolean {
	const wanted = (hint.title ?? "").trim();
	if (wanted === "") return false;
	if (groundedRatio(wanted, found.title) < TITLE_MATCH) return false;

	// 제목만으로는 판본·동명이서를 가릴 수 없다. 지은이나 출판사 중 하나는 맞아야 한다.
	const author = (hint.author ?? "").trim();
	const publisher = (hint.publisher ?? "").trim();
	if (author === "" && publisher === "") return true;

	return (
		(author !== "" && groundedRatio(author, found.author) >= PERSON_MATCH) ||
		(publisher !== "" && groundedRatio(publisher, found.publisher) >= PERSON_MATCH)
	);
}

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

/* ── 알라딘 ────────────────────────────────────────── */

interface AladinItem {
	title?: string;
	author?: string;
	publisher?: string;
	pubDate?: string;
	isbn13?: string;
	description?: string;
	link?: string;
}

interface AladinResponse {
	item?: AladinItem[];
	errorCode?: number;
	errorMessage?: string;
}

const ALADIN_BASE = "https://www.aladin.co.kr/ttb/api";

function aladinUrl(endpoint: string, key: string, params: Record<string, string>): string {
	const url = new URL(`${ALADIN_BASE}/${endpoint}.aspx`);
	url.searchParams.set("ttbkey", key);
	url.searchParams.set("output", "js");
	url.searchParams.set("Version", "20131101");
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return url.toString();
}

const toAladinRecord = (item: AladinItem): BibRecord | null => {
	if (!item.title) return null;

	return {
		title: item.title,
		author: item.author ?? "",
		publisher: item.publisher ?? "",
		isbn13: item.isbn13 ?? "",
		publishedAt: item.pubDate ?? "",
		description: stripHtml(item.description ?? ""),
		source: "aladin",
		// ToS 상 출처 링크가 필요하다. 상품 페이지를 쓴다.
		// 응답의 link 는 `&amp;` 로 이스케이프돼 온다(실측). 그대로 두면 화면·DB 에 남는다.
		url: item.link ? decodeEntities(item.link) : "https://www.aladin.co.kr/",
	};
};

/**
 * 알라딘 조회. ISBN 이 있으면 정확 조회, 없으면 제목 검색 후 같은 책인지 확인한다.
 *
 * `errorCode` 가 오면 조용히 포기한다 — 키가 만료됐거나 할당량이 찼거나 승인이 풀린 경우이고,
 * 어느 쪽이든 이 요청에서 할 수 있는 일이 없다.
 */
async function fromAladin(
	key: string,
	hint: { isbn?: string; title?: string; author?: string; publisher?: string },
): Promise<BibRecord | null> {
	const isbn = hint.isbn ? normalizeIsbn(hint.isbn) : "";

	// ISBN 조회는 정확하지만 **그 ISBN 자체가 표지 OCR 에서 나온 값이다.** 실측: 『마당을 나온
	// 암탉』 표지에서 9788958281252 를 읽어 조회했더니 『즐거움과 상상력을 주는 과학』이 왔다.
	// 조회가 정확한 것과 입력이 맞는 것은 다른 문제다. 그래서 결과를 제목과 대조하고,
	// 안 맞으면 ISBN 을 버리고 제목으로 되짚는다.
	if (isbn.length === 13) {
		const body = await getJson<AladinResponse>(
			aladinUrl("ItemLookUp", key, { itemIdType: "ISBN13", ItemId: isbn }),
		);
		const record = body?.item?.[0] ? toAladinRecord(body.item[0]) : null;
		if (record && accepts(hint, record)) return record;
	}

	const title = (hint.title ?? "").trim();
	if (title === "") return null;

	const body = await getJson<AladinResponse>(
		aladinUrl("ItemSearch", key, {
			Query: title,
			QueryType: "Title",
			// 첫 결과가 다른 판본일 수 있다. 몇 개 받아 그중 맞는 것을 고른다.
			MaxResults: "5",
			start: "1",
			SearchTarget: "Book",
		}),
	);

	for (const item of body?.item ?? []) {
		const record = toAladinRecord(item);
		if (record && isSameBook(hint, record)) return record;
	}

	// 검색은 됐지만 찾던 책이 아니다. 엉뚱한 책의 정보를 넘기는 것보다 없는 편이 낫다.
	return null;
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
export async function lookup(
	env: AppEnv,
	hint: {
		isbn?: string;
		title?: string;
		author?: string;
		publisher?: string;
	},
): Promise<BibRecord[]> {
	const isbn = hint.isbn ? normalizeIsbn(hint.isbn) : "";
	const terms = [hint.title, hint.author, hint.publisher].filter(Boolean).join(" ");

	// 키가 없으면 그 소스는 아예 부르지 않는다. 없는 키로 부르면 오류만 늘고 지연만 생긴다.
	const aladin = env.ALADIN_TTB_KEY ? fromAladin(env.ALADIN_TTB_KEY, hint) : Promise.resolve(null);

	if (isValidIsbn(isbn)) {
		const [korean, google, openLibrary] = await Promise.all([
			aladin,
			fromGoogleBooks(`isbn:${isbn}`),
			fromOpenLibrary(isbn),
		]);
		// 국내책은 알라딘이 가장 정확하다. 앞에 둬야 `bib[0]` 를 기준점으로 쓰는 병합이 맞게 돈다.
		return keepMatching(hint, [korean, google, openLibrary]);
	}

	if (terms.trim() === "") return [];

	const [korean, google] = await Promise.all([aladin, fromGoogleBooks(terms)]);
	return keepMatching(hint, [korean, google]);
}

/**
 * 찾던 책이 아닌 결과를 걸러낸다. **소스마다 하지 않고 여기 한 곳에서 한다.**
 *
 * ISBN 이 표지 OCR 에서 온 값이라는 문제는 알라딘만의 것이 아니다 — 잘못 읽은 ISBN 으로
 * Google Books·Open Library 를 불러도 똑같이 다른 책이 온다. 소스가 늘어날 때마다 같은
 * 검사를 다시 붙이는 대신, 결과가 모이는 자리에서 한 번 본다.
 *
 * 이 검사가 없으면 다른 책의 서지가 `mergeMetadata` 의 기준점(`bib[0]`)이 되어 제목·저자를
 * 덮어쓰고, 그 책의 소개가 Brief 에 들어가 **"근거가 있는" 틀린 문항**이 만들어진다.
 */
function keepMatching(
	hint: { title?: string; author?: string; publisher?: string },
	records: (BibRecord | null)[],
): BibRecord[] {
	return records.filter((r): r is BibRecord => r !== null && accepts(hint, r));
}
