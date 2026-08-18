import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { normalizeResearch, type BookResearch } from "../src/search/web";
import { applyResearch } from "../src/services/book";
import { signupParent } from "./helpers";

/**
 * 영문책의 읽기 난이도 — AR(ATOS) 과 Lexile.
 *
 * 이 값은 **부모가 아이에게 맞는 책인지 고르는 기준**이 된다. 그래서 두 가지가 중요하다.
 *  1. 형식이 어긋난 값은 고쳐 쓰지 않고 버린다 — 틀린 등급은 없는 것보다 나쁘다.
 *  2. 검사는 서버에서 한다 — 브라우저 릴레이 경로에서는 모델 응답이 클라이언트를 거쳐 온다.
 */

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
	arLevel: "4.4",
	arPoints: "5.0",
	arInterestLevel: "MG",
	lexile: "680L",
	description: "A pig named Wilbur is saved by a spider.",
	plotSummary: "Wilbur is saved from slaughter by Charlotte, who writes words in her web.",
	characters: [{ name: "Wilbur", role: "the pig" }],
	keyEvents: ["Charlotte writes SOME PIG", "Charlotte dies at the fair"],
	sources: [{ url: "https://example.com/charlotte", title: "Charlotte's Web", content: "요약" }],
	...over,
});

describe("읽기 난이도 형식 검사", () => {
	it("제대로 된 값은 표준 표기로 통과한다", () => {
		const result = normalizeResearch(
			research({ arLevel: "4.4", arPoints: "5", arInterestLevel: "mg", lexile: " 680l " }),
		);

		expect(result.arLevel).toBe("4.4");
		expect(result.arPoints).toBe("5");
		// 대소문자·공백이 어떻게 오든 화면에는 한 가지 표기만 보여야 한다.
		expect(result.arInterestLevel).toBe("MG");
		expect(result.lexile).toBe("680L");
	});

	it("렉사일 접두어를 살린다", () => {
		// AD(성인지도) · BR(초보) 같은 접두어는 지수만큼이나 중요한 정보다.
		expect(normalizeResearch(research({ lexile: "AD540L" })).lexile).toBe("AD540L");
		expect(normalizeResearch(research({ lexile: "br200l" })).lexile).toBe("BR200L");
	});

	/** 여기가 핵심이다. 모델이 말로 풀어 쓰거나 지어낸 값을 그대로 저장하면 안 된다. */
	it("형식이 어긋난 값은 고쳐 쓰지 않고 버린다", () => {
		const result = normalizeResearch(
			research({
				arLevel: "약 4학년 수준",
				arPoints: "모름",
				arInterestLevel: "초등 중학년",
				// 끝의 L 이 없으면 렉사일 지수가 아니다.
				lexile: "680",
			}),
		);

		expect(result.arLevel).toBe("");
		expect(result.arPoints).toBe("");
		expect(result.arInterestLevel).toBe("");
		expect(result.lexile).toBe("");
	});

	it("실존 범위를 벗어난 값은 버린다", () => {
		expect(normalizeResearch(research({ arLevel: "99" })).arLevel).toBe("");
		expect(normalizeResearch(research({ arLevel: "0" })).arLevel).toBe("");
		expect(normalizeResearch(research({ arPoints: "9999" })).arPoints).toBe("");
	});

	/**
	 * 한국어 책에는 AR·Lexile 이 매겨지지 않는다. 등급이 달려 왔다면 모델이 다른 책
	 * (원서나 다른 번역본)의 값을 가져온 것이므로 전부 버린다.
	 */
	it("한국어 책으로 특정된 책의 등급은 전부 버린다", () => {
		const result = normalizeResearch(
			research({ bookLanguage: "ko", arLevel: "4.4", lexile: "680L", arInterestLevel: "MG" }),
		);

		expect(result.arLevel).toBe("");
		expect(result.lexile).toBe("");
		expect(result.arInterestLevel).toBe("");
	});

	it("언어를 특정하지 못했어도 등급 자체는 남긴다", () => {
		// AR·Lexile 이 붙었다는 것 자체가 영문책이라는 뜻이다. 언어를 못 읽었다고 버리면
		// 멀쩡히 확인한 등급을 잃는다.
		const result = normalizeResearch(research({ bookLanguage: "", lexile: "680L" }));
		expect(result.lexile).toBe("680L");
	});

	it("언어 코드가 아닌 값은 비운다", () => {
		expect(normalizeResearch(research({ bookLanguage: "영어" })).bookLanguage).toBe("");
		expect(normalizeResearch(research({ bookLanguage: "eng" })).bookLanguage).toBe("");
		expect(normalizeResearch(research({ bookLanguage: "EN" })).bookLanguage).toBe("en");
	});
});

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

/** 표지만 올린 책. 조사 준비 단계의 서지 캐시를 채워 서지 API 를 부르지 않게 한다. */
async function bookReady(): Promise<{ client: Awaited<ReturnType<typeof signupParent>>["client"]; bookId: string; userId: string }> {
	const { client } = await signupParent();
	const form = new FormData();
	form.append("cover", new File([PNG_BYTES], "cover.png", { type: "image/png" }));
	const created = await client.upload("/api/books", form);
	const bookId = created.body.data.book.id;

	await env.DB.prepare("UPDATE books SET bib_cache = ? WHERE id = ?")
		.bind(
			JSON.stringify([
				{
					source: "openlibrary",
					title: "Charlotte's Web",
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

describe("읽기 난이도가 책 정보에 실린다", () => {
	it("영문책이면 AR 과 Lexile 을 화면에 내려보낸다", async () => {
		const { client, bookId, userId } = await bookReady();

		await applyResearch(env, userId, bookId, normalizeResearch(research()), notices);

		const { book } = (await client.request(`/api/books/${bookId}`)).body.data;
		expect(book.language).toBe("en");
		expect(book.readingLevel).toEqual({
			ar: 4.4,
			arPoints: 5,
			arInterest: "MG",
			lexile: "680L",
		});
	});

	it("한국어 책에는 난이도 자리를 만들지 않는다", async () => {
		const { client, bookId, userId } = await bookReady();

		await applyResearch(
			env,
			userId,
			bookId,
			normalizeResearch(research({ bookLanguage: "ko", arLevel: "4.4", lexile: "680L" })),
			notices,
		);

		const { book } = (await client.request(`/api/books/${bookId}`)).body.data;
		expect(book.language).toBe("ko");
		// 통째로 null 이라야 화면이 "해당 없음" 과 "아직 못 찾음" 을 구분할 수 있다.
		expect(book.readingLevel).toBeNull();
	});

	it("일부만 알아내도 아는 것만 보여 준다", async () => {
		const { client, bookId, userId } = await bookReady();

		await applyResearch(
			env,
			userId,
			bookId,
			normalizeResearch(research({ arLevel: "", arPoints: "", arInterestLevel: "" })),
			notices,
		);

		const { book } = (await client.request(`/api/books/${bookId}`)).body.data;
		expect(book.readingLevel).toEqual({ ar: null, arPoints: null, arInterest: null, lexile: "680L" });
	});

	/**
	 * 다시 조사할 때마다 등급이 흔들리면 부모가 어느 값을 믿어야 할지 알 수 없다.
	 * 다른 서지 필드와 같은 규칙 — 이미 있는 값이 이긴다.
	 */
	it("다시 조사해도 이미 확인한 등급은 바뀌지 않는다", async () => {
		const { client, bookId, userId } = await bookReady();
		await applyResearch(env, userId, bookId, normalizeResearch(research()), notices);

		await applyResearch(
			env,
			userId,
			bookId,
			normalizeResearch(research({ arLevel: "7.7", lexile: "990L" })),
			notices,
		);

		const { book } = (await client.request(`/api/books/${bookId}`)).body.data;
		expect(book.readingLevel.ar).toBe(4.4);
		expect(book.readingLevel.lexile).toBe("680L");
	});

	it("조사가 빈손이면 난이도도 비운다", async () => {
		const { client, bookId, userId } = await bookReady();

		await applyResearch(
			env,
			userId,
			bookId,
			normalizeResearch(research({ found: false, plotSummary: "", characters: [], lexile: "" })),
			notices,
		);

		const { book } = (await client.request(`/api/books/${bookId}`)).body.data;
		expect(book.readingLevel).toBeNull();
	});
});
