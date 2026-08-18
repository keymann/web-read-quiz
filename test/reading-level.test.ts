import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildQuery, extract, lookup, vote } from "../src/search/reading-level";
import { normalizeResearch, type BookResearch } from "../src/search/web";
import { applyResearch } from "../src/services/book";
import type { AppEnv } from "../src/types";
import { signupParent } from "./helpers";

/**
 * 영문책의 읽기 난이도 — AR(ATOS) 과 Lexile.
 *
 * 처음에는 줄거리 조사 프롬프트에 필드만 얹어 두었는데 획득률이 0/2 였다. 그 조사가 던지는
 * 질의(`plot summary characters book review`)로는 등급이 적힌 페이지가 결과에 아예 들어오지
 * 않아, 모델은 볼 자료 없이 정직하게 빈칸을 돌려줬다.
 *
 * 지금은 등급을 겨냥한 질의를 따로 던지고 정규식으로 뽑는다. 그래서 여기서 지켜야 할 것은
 * 두 가지다 — **읽어낼 것을 읽어내는가**, 그리고 **엉뚱한 숫자를 물어오지 않는가.**
 */

/* ── 페이지에서 뽑아내기 ─────────────────────────────── */

describe("등급 뽑아내기", () => {
	it("AR BookFinder 식 표기를 읽는다", () => {
		const page =
			"Charlotte's Web by E.B. White. Interest Level: Middle Grades (MG) " +
			"ATOS Book Level: 4.4 AR Points: 5.0 Word Count: 31938";

		expect(extract(page)).toEqual({
			arLevel: "4.4",
			arPoints: "5.0",
			arInterestLevel: "MG",
			lexile: "",
		});
	});

	it("서점 상세 식 표기를 읽는다", () => {
		const page = "Reading age 8 - 12 years ‏ Lexile measure ‏ : ‎ 680L ‏ Grade level 3 - 7";
		expect(extract(page).lexile).toBe("680L");
	});

	it("렉사일 접두어를 살린다", () => {
		// AD(성인지도)·BR(초보) 은 지수만큼 중요한 정보다.
		expect(extract("Lexile Measure: AD540L").lexile).toBe("AD540L");
		expect(extract("lexile measure br200l").lexile).toBe("BR200L");
	});

	it("흥미 수준을 말로 적어도 읽는다", () => {
		expect(extract("Interest Level: Upper Grades").arInterestLevel).toBe("UG");
		expect(extract("Interest Level: Lower Grades").arInterestLevel).toBe("LG");
		// MG+ 를 MG 로 먼저 맞히면 `+` 를 잃는다.
		expect(extract("Interest Level: Middle Grades Plus").arInterestLevel).toBe("MG+");
	});

	it("이름표 표기가 조금씩 달라도 읽는다", () => {
		expect(extract("ATOS Level 4.4").arLevel).toBe("4.4");
		expect(extract("AR Book Level – 3.2").arLevel).toBe("3.2");
	});
});

/* ── 엉뚱한 숫자를 물지 않기 ─────────────────────────── */

describe("잘못 무는 것 막기", () => {
	/**
	 * 여기가 이 기능에서 가장 위험한 자리다. 부모는 숫자를 그냥 믿는다.
	 */
	it("렉사일을 말하지 않는 페이지의 `500L` 은 무시한다", () => {
		const page = "This 500L capacity tank holds water. A 1200L model is also available.";
		expect(extract(page).lexile).toBe("");
	});

	it("AR 을 말하지 않는 페이지의 `Points` 는 무시한다", () => {
		const page = "Talking Points: 3.5 stars from our reviewers.";
		expect(extract(page).arPoints).toBe("");
	});

	it("실존 범위를 벗어난 값은 버린다", () => {
		expect(extract("ATOS Book Level: 99.9").arLevel).toBe("");
		expect(extract("ATOS Book Level: 0.0").arLevel).toBe("");
		expect(extract("ATOS Book Level: 4.4 AR Points: 999.9").arPoints).toBe("");
	});

	it("아무것도 없으면 빈 값을 준다", () => {
		expect(extract("A lovely story about a pig and a spider.")).toEqual({
			arLevel: "",
			arPoints: "",
			arInterestLevel: "",
			lexile: "",
		});
	});
});

/* ── 여러 페이지의 값 모으기 ─────────────────────────── */

const src = (value: Partial<ReturnType<typeof extract>>, url: string) => ({
	value: { arLevel: "", arPoints: "", arInterestLevel: "", lexile: "", ...value },
	url,
	title: url,
});

describe("표 모으기", () => {
	it("한 페이지만 말해도 받아들인다", () => {
		// 여러 곳이 일치할 때까지 기다리면 자료가 얇은 책은 영영 빈칸이 된다.
		const out = vote([src({ lexile: "680L" }, "https://a.example")]);
		expect(out.lexile).toBe("680L");
		expect(out.sources).toEqual([{ url: "https://a.example", title: "https://a.example" }]);
	});

	it("표가 갈리면 다수를 따른다", () => {
		const out = vote([
			src({ arLevel: "4.4" }, "https://a.example"),
			src({ arLevel: "7.1" }, "https://b.example"),
			src({ arLevel: "4.4" }, "https://c.example"),
		]);
		expect(out.arLevel).toBe("4.4");
	});

	it("표가 같으면 관련도가 높은 쪽을 따른다", () => {
		// 넘겨받는 순서가 곧 관련도 순이다.
		const out = vote([
			src({ lexile: "680L" }, "https://a.example"),
			src({ lexile: "990L" }, "https://b.example"),
		]);
		expect(out.lexile).toBe("680L");
	});

	it("항목마다 따로 센다", () => {
		const out = vote([
			src({ arLevel: "4.4" }, "https://a.example"),
			src({ lexile: "680L" }, "https://b.example"),
		]);
		expect(out.arLevel).toBe("4.4");
		expect(out.lexile).toBe("680L");
		expect(out.sources).toHaveLength(2);
	});

	it("아무도 말하지 않으면 빈 값이다", () => {
		expect(vote([src({}, "https://a.example")])).toEqual({
			arLevel: "",
			arPoints: "",
			arInterestLevel: "",
			lexile: "",
			sources: [],
		});
	});
});

describe("질의", () => {
	/** 질의가 곧 이 기능의 전부다. 등급 페이지가 쓰는 이름표를 그대로 물어야 올라온다. */
	it("등급이 적힌 페이지가 쓰는 낱말로 묻는다", () => {
		const q = buildQuery({ title: "Charlotte's Web", author: "E. B. White" });
		expect(q).toContain('"Charlotte\'s Web"');
		expect(q).toContain("ATOS");
		expect(q).toContain("Lexile");
	});
});

/* ── 조회 ────────────────────────────────────────────── */

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const withKeys = (...keys: (string | undefined)[]): AppEnv =>
	({
		...env,
		TAVILY_API_KEY: keys[0],
		TAVILY_API_KEY2: keys[1],
		TAVILY_API_KEY3: keys[2],
		TAVILY_API_KEY4: keys[3],
	}) as never as AppEnv;

const noKeys = withKeys();
const oneKey = withKeys("tvly-a");

function mockTavily(results: unknown[], times = 1) {
	fetchMock
		.get("https://api.tavily.com")
		.intercept({ path: "/search", method: "POST" })
		.reply(200, { results })
		.times(times);
}

const HINT = { title: "Charlotte's Web", author: "E. B. White" };

describe("조회", () => {
	it("검색 결과에서 등급을 뽑아 온다", async () => {
		mockTavily([
			{
				url: "https://www.arbookfind.com/charlottes-web",
				title: "Charlotte's Web - AR BookFinder",
				content: "ATOS Book Level: 4.4 AR Points: 5.0 Interest Level: Middle Grades (MG)",
				score: 0.95,
			},
			{
				url: "https://hub.lexile.com/charlottes-web",
				title: "Charlotte's Web | Lexile Hub",
				content: "Lexile measure: 680L",
				score: 0.9,
			},
		]);

		const out = await lookup(oneKey, HINT);
		expect(out).toMatchObject({
			arLevel: "4.4",
			arPoints: "5.0",
			arInterestLevel: "MG",
			lexile: "680L",
		});
		expect(out.sources).toHaveLength(2);
	});

	/**
	 * 같은 시리즈의 다른 권, 같은 제목의 다른 책이 흔하다. 줄거리라면 부모가 읽고
	 * 알아채지만 숫자는 그냥 믿게 되므로, 제목이 맞지 않는 페이지는 아예 보지 않는다.
	 */
	it("다른 책 페이지의 등급은 가져오지 않는다", async () => {
		mockTavily([
			{
				url: "https://www.arbookfind.com/stuart-little",
				title: "Stuart Little - AR BookFinder",
				content: "ATOS Book Level: 6.0 AR Points: 3.0 Lexile measure: 920L",
				score: 0.95,
			},
		]);

		expect(await lookup(oneKey, HINT)).toMatchObject({ arLevel: "", lexile: "" });
	});

	it("키가 없으면 검색하지 않는다", async () => {
		// 인터셉터를 걸지 않았는데 통과했다 = 외부를 부르지 않았다.
		expect(await lookup(noKeys, HINT)).toMatchObject({ arLevel: "", lexile: "" });
	});

	it("제목이 비었으면 검색하지 않는다", async () => {
		expect(await lookup(oneKey, { title: "  ", author: "" })).toMatchObject({ lexile: "" });
	});

	it("찾지 못해도 빈 값으로 돌아온다", async () => {
		mockTavily([]);
		expect(await lookup(oneKey, HINT)).toMatchObject({ arLevel: "", lexile: "" });
	});
});

/* ── 책에 반영되기까지 ───────────────────────────────── */

/** 최소한의 유효한 PNG 1x1. 매직 바이트 검증을 통과한다. */
const PNG_BYTES = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

const research = (over: Partial<BookResearch> = {}): BookResearch => ({
	found: true,
	title: "Charlotte's Web",
	author: "E. B. White",
	publisher: "Harper & Brothers",
	isbn13: "9780064400558",
	publishedAt: "1952-10-15",
	targetAge: "8-12",
	bookLanguage: "en",
	description: "A pig named Wilbur is saved by a spider.",
	plotSummary: "Wilbur is saved from slaughter by Charlotte, who writes words in her web.",
	characters: [{ name: "Wilbur", role: "the pig" }],
	keyEvents: ["Charlotte writes SOME PIG"],
	sources: [{ url: "https://example.com/charlotte", title: "Charlotte's Web", content: "요약" }],
	...over,
});

/** 표지만 올린 책. 서지 캐시를 채워 서지 API 를 부르지 않게 한다. */
async function bookReady(title = "Charlotte's Web"): Promise<{
	client: Awaited<ReturnType<typeof signupParent>>["client"];
	bookId: string;
	userId: string;
}> {
	const { client } = await signupParent();
	const form = new FormData();
	form.append("cover", new File([PNG_BYTES], "cover.png", { type: "image/png" }));
	const created = await client.upload("/api/books", form);
	const bookId = created.body.data.book.id;

	await env.DB.prepare("UPDATE books SET title = ?, bib_cache = ? WHERE id = ?")
		.bind(
			title,
			JSON.stringify([
				{
					source: "openlibrary",
					title,
					author: "E. B. White",
					publisher: "Harper & Brothers",
					publishedAt: "1952-10-15",
					isbn13: "9780064400558",
					url: "https://example.com/charlotte",
					description: "A pig named Wilbur is saved by a spider.",
				},
			]),
			bookId,
		)
		.run();

	const owner = await env.DB.prepare("SELECT created_by FROM books WHERE id = ?")
		.bind(bookId)
		.first<{ created_by: string }>();

	return { client, bookId, userId: owner!.created_by };
}

const notices = {
	groundingUsed: false,
	searchNotice: null,
	modelNotice: null,
	model: "gemini-3.6-flash",
};

const LEVEL_PAGE = [
	{
		url: "https://www.arbookfind.com/charlottes-web",
		title: "Charlotte's Web - AR BookFinder",
		content:
			"ATOS Book Level: 4.4 AR Points: 5.0 Interest Level: Middle Grades (MG) Lexile measure: 680L",
		score: 0.95,
	},
];

describe("책에 반영되기까지", () => {
	it("영문책이면 조사할 때 등급도 함께 찾아 채운다", async () => {
		const { client, bookId, userId } = await bookReady();
		mockTavily(LEVEL_PAGE);

		await applyResearch(oneKey, userId, bookId, normalizeResearch(research()), notices);

		const { book } = (await client.request(`/api/books/${bookId}`)).body.data;
		expect(book.language).toBe("en");
		expect(book.readingLevel).toEqual({
			ar: 4.4,
			arPoints: 5,
			arInterest: "MG",
			lexile: "680L",
		});
	});

	/** 한국어 책에는 매겨지지 않는 척도다. 찾아 나서면 크레딧만 버린다. */
	it("한국어 책이면 찾지 않는다", async () => {
		const { client, bookId, userId } = await bookReady("마당을 나온 암탉");

		// 인터셉터를 걸지 않았는데 통과했다 = Tavily 를 부르지 않았다.
		await applyResearch(
			oneKey,
			userId,
			bookId,
			normalizeResearch(research({ title: "마당을 나온 암탉", bookLanguage: "ko" })),
			notices,
		);

		const { book } = (await client.request(`/api/books/${bookId}`)).body.data;
		expect(book.readingLevel).toBeNull();
	});

	it("이미 다 채워져 있으면 다시 찾지 않는다", async () => {
		const { bookId, userId } = await bookReady();
		await env.DB.prepare("UPDATE books SET ar_level = 4.4, lexile = '680L' WHERE id = ?")
			.bind(bookId)
			.run();

		// 인터셉터 없음 = 외부를 부르지 않았다.
		await applyResearch(oneKey, userId, bookId, normalizeResearch(research()), notices);
	});

	/**
	 * 다시 조사할 때마다 등급이 흔들리면 부모가 어느 값을 믿어야 할지 알 수 없다.
	 * 비어 있던 자리만 채우고 확인해 둔 값은 그대로 둔다.
	 */
	it("빈 자리만 채우고 확인해 둔 값은 그대로 둔다", async () => {
		const { client, bookId, userId } = await bookReady();
		await env.DB.prepare("UPDATE books SET ar_level = 9.9 WHERE id = ?").bind(bookId).run();
		mockTavily(LEVEL_PAGE);

		await applyResearch(oneKey, userId, bookId, normalizeResearch(research()), notices);

		const { book } = (await client.request(`/api/books/${bookId}`)).body.data;
		expect(book.readingLevel.ar).toBe(9.9);
		expect(book.readingLevel.lexile).toBe("680L");
	});

	/** 줄거리를 못 찾은 것과 등급이 없는 것은 다른 일이다. */
	it("조사가 빈손이어도 등급은 찾는다", async () => {
		const { client, bookId, userId } = await bookReady();
		mockTavily(LEVEL_PAGE);

		await applyResearch(
			oneKey,
			userId,
			bookId,
			normalizeResearch(research({ found: false, plotSummary: "", characters: [] })),
			notices,
		);

		const { book } = (await client.request(`/api/books/${bookId}`)).body.data;
		expect(book.readingLevel.lexile).toBe("680L");
	});

	it("언어를 특정하지 못해도 제목이 영어면 찾는다", async () => {
		const { client, bookId, userId } = await bookReady();
		mockTavily(LEVEL_PAGE);

		await applyResearch(
			oneKey,
			userId,
			bookId,
			normalizeResearch(research({ bookLanguage: "" })),
			notices,
		);

		const { book } = (await client.request(`/api/books/${bookId}`)).body.data;
		expect(book.readingLevel.lexile).toBe("680L");
	});
});
