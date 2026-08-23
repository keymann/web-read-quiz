import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { isSameBook, lookup } from "../src/search/bibliographic";
import { FIXTURE_PLOT, signupParent } from "./helpers";

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

const mockOpenAi = (payload: unknown) =>
	fetchMock
		.get("https://api.openai.com")
		.intercept({ path: "/v1/responses", method: "POST" })
		.reply(200, {
			status: "completed",
			output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(payload) }] }],
		});

/**
 * 서지 조회 — 특히 **알라딘**(§docs/korean-book-api-plan.md).
 *
 * 국내책은 Google Books·Open Library 로 거의 잡히지 않아 Brief 가 모델 기억으로 채워졌고,
 * 근거 검사가 그 문항을 걸러내 문항이 부족해졌다. 알라딘이 그 고리를 끊는다.
 *
 * 여기서 가장 중요한 것은 **잘못된 책을 받아들이지 않는 것**이다. 다른 책의 책소개가 Brief 에
 * 들어가면 그 책에 "근거가 있는" 틀린 문항이 만들어지고 근거 검사가 통과시킨다.
 */

const ALADIN = "https://www.aladin.co.kr";

/** 실측 응답 모양. `description` 에 HTML 이 섞여 오는 것까지 그대로 재현한다. */
const HANARM = {
	title: "마당을 나온 암탉 (반양장) - 아동용",
	author: "황선미 (지은이), 김환영 (그림)",
	publisher: "사계절",
	pubDate: "2000-05-29",
	isbn13: "9788971968710",
	/**
	 * **실제 응답 그대로.** 두 가지 함정이 다 들어 있다.
	 *  - 태그 안에 ASP 블록(`<% … %>`) — 태그부터 지우면 `">` 가 남는다
	 *  - 꺾쇠로 감싼 책 제목이 **이스케이프 없이** 옴 — 태그로 보고 지우면 본문이 사라진다
	 */
	description:
		'<a href="/catalog/book.asp?ISBN=8901028514&UID=<% =qsUID %>"><나쁜 어린이표></a>로 아이들만의 생각을 &amp; 절묘하게 표현해냈던 황선미의 장편동화.',
	// link 도 `&amp;` 로 이스케이프돼 온다.
	link: "https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=914024&amp;partner=op",
};

/** 같은 검색어로 함께 잡히는 **다른 책**. 실제로 이런 일이 일어난다. */
const OTHER_BOOK = {
	title: "마두의 말씨앗",
	author: "문선이 (지은이), 정지윤 (그림)",
	publisher: "사계절",
	pubDate: "2007-04-30",
	isbn13: "9788958282242",
	description: "이 작품이 그저 그런 생활동화에 그치지 않는 것은",
	link: "https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=914025",
};

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

const mockAladin = (endpoint: string, body: unknown) =>
	fetchMock
		.get(ALADIN)
		.intercept({ path: (p) => p.includes(`/${endpoint}.aspx`), method: "GET" })
		.reply(200, body);

/** 알라딘만 보려는 테스트에서 나머지 소스를 잠재운다. */
function silenceOthers() {
	fetchMock
		.get("https://www.googleapis.com")
		.intercept({ path: (p) => p.startsWith("/books/v1/volumes"), method: "GET" })
		.reply(200, {})
		.times(1);
	fetchMock
		.get("https://openlibrary.org")
		.intercept({ path: (p) => p.startsWith("/api/books"), method: "GET" })
		.reply(200, {})
		.times(1);
}

const withKey = { ...env, ALADIN_TTB_KEY: "ttbtest0000000001" };
const withBoth = { ...withKey, KAKAO_REST_KEY: "kakaotest0000000000000000000001" };

const KAKAO = "https://dapi.kakao.com";

/** 실측 응답 모양. `isbn` 이 `"ISBN10 ISBN13"` 로 붙어 오는 것까지 그대로. */
const KAKAO_HANARM = {
	title: "마당을 나온 암탉",
	authors: ["황선미"],
	translators: [],
	publisher: "사계절",
	datetime: "2023-07-31T00:00:00.000+09:00",
	isbn: "8971968710 9788971968710",
	contents: "2017 대한민국 문화예술상을 수상한 황선미의 『마당을 나온 암탉』은 알을 품어 병아리의 탄생을 보겠다는 소망을 가지고 양계장을 나온 암탉 잎싹의 이야기를 그린 작품이다.",
	url: "https://search.daum.net/search?w=bookpage&amp;bookId=992873",
};

const mockKakao = (body: unknown) =>
	fetchMock
		.get(KAKAO)
		.intercept({ path: (p) => p.startsWith("/v3/search/book"), method: "GET" })
		.reply(200, body);

describe("같은 책인지 확인", () => {
	// 판본 표기가 후보에만 더 붙는다. 그것 때문에 떨어뜨리면 국내책이 거의 안 잡힌다.
	it("판본·부제가 붙은 제목도 같은 책으로 본다", () => {
		expect(
			isSameBook(
				{ title: "마당을 나온 암탉", author: "황선미" },
				{ title: "마당을 나온 암탉 (반양장) - 아동용", author: "황선미 (지은이), 김환영 (그림)", publisher: "사계절" },
			),
		).toBe(true);
	});

	it("출판사만 알아도 통과한다", () => {
		expect(
			isSameBook(
				{ title: "마당을 나온 암탉", publisher: "사계절" },
				{ title: "마당을 나온 암탉 (출간 20주년 기념판)", author: "황선미", publisher: "사계절" },
			),
		).toBe(true);
	});

	// 같은 검색어에 함께 잡히는 다른 책. 출판사가 같아도 제목이 다르면 걸러야 한다.
	it("출판사가 같아도 제목이 다르면 거른다", () => {
		expect(
			isSameBook(
				{ title: "마당을 나온 암탉", author: "황선미", publisher: "사계절" },
				{ title: "마두의 말씨앗", author: "문선이 (지은이)", publisher: "사계절" },
			),
		).toBe(false);
	});

	it("제목이 같아도 지은이·출판사가 모두 다르면 거른다", () => {
		expect(
			isSameBook(
				{ title: "마당을 나온 암탉", author: "황선미", publisher: "사계절" },
				{ title: "마당을 나온 암탉", author: "다른작가", publisher: "다른출판사" },
			),
		).toBe(false);
	});

	// 표지에서 지은이·출판사를 못 읽는 일은 흔하다. 그때는 제목만으로 받아들인다.
	it("지은이·출판사를 모르면 제목만으로 받아들인다", () => {
		expect(
			isSameBook(
				{ title: "마당을 나온 암탉" },
				{ title: "마당을 나온 암탉 (반양장)", author: "황선미", publisher: "사계절" },
			),
		).toBe(true);
	});

	it("제목이 비어 있으면 받아들이지 않는다", () => {
		expect(isSameBook({ author: "황선미" }, { title: "아무 책", author: "황선미", publisher: "사계절" })).toBe(false);
	});
});

describe("알라딘 조회", () => {
	it("ISBN13 이면 정확 조회하고 HTML 을 정리한다", async () => {
		mockAladin("ItemLookUp", { item: [HANARM] });
		silenceOthers();

		const records = await lookup(withKey, { isbn: "978-89-7196-871-0" });
		const aladin = records.find((r) => r.source === "aladin");

		expect(aladin).toBeTruthy();
		expect(aladin!.title).toBe("마당을 나온 암탉 (반양장) - 아동용");
		expect(aladin!.isbn13).toBe("9788971968710");
		// 링크의 `&amp;` 도 되돌려야 한다. 그대로 두면 화면과 DB 에 남는다.
		expect(aladin!.url).toBe("https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=914024&partner=op");

		// 태그는 사라지고 엔티티는 되돌아온다. 그대로 두면 프롬프트에 태그가 들어간다.
		expect(aladin!.description).not.toContain("<a ");
		expect(aladin!.description).not.toContain("&lt;");
		// 꺾쇠로 감싼 책 제목은 본문이다. 태그로 보고 지우면 통째로 사라진다(실측에서 그랬다).
		expect(aladin!.description).toMatch(/^<나쁜 어린이표>로 아이들만의/);
		expect(aladin!.description).toContain("생각을 & 절묘하게");
		// ASP 블록 때문에 남던 찌꺼기. 실측에서 `">로 아이들만의…` 로 보였다.
		expect(aladin!.description).not.toContain('">');
		expect(aladin!.description).not.toContain("%>");
		expect(aladin!.description).not.toContain("<a href");
	});

	// 국내책은 알라딘이 가장 정확하다. bib[0] 를 기준점으로 쓰는 병합이 맞게 돌아야 한다.
	it("결과 목록에서 알라딘이 앞에 온다", async () => {
		mockAladin("ItemLookUp", { item: [HANARM] });
		fetchMock
			.get("https://www.googleapis.com")
			.intercept({ path: (p) => p.startsWith("/books/v1/volumes"), method: "GET" })
			.reply(200, { items: [{ volumeInfo: { title: "구글이 아는 제목" } }] });
		fetchMock
			.get("https://openlibrary.org")
			.intercept({ path: (p) => p.startsWith("/api/books"), method: "GET" })
			.reply(200, {});

		const records = await lookup(withKey, { isbn: "9788971968710" });
		expect(records[0]!.source).toBe("aladin");
	});

	it("ISBN 이 없으면 제목으로 검색해 같은 책을 고른다", async () => {
		// 첫 결과가 다른 책이어도 목록에서 맞는 것을 찾아낸다.
		mockAladin("ItemSearch", { item: [OTHER_BOOK, HANARM] });
		fetchMock
			.get("https://www.googleapis.com")
			.intercept({ path: (p) => p.startsWith("/books/v1/volumes"), method: "GET" })
			.reply(200, {});

		const records = await lookup(withKey, { title: "마당을 나온 암탉", author: "황선미" });
		const aladin = records.find((r) => r.source === "aladin");

		expect(aladin?.isbn13).toBe("9788971968710");
	});

	/**
	 * 이 테스트가 이 파일의 핵심이다.
	 *
	 * 엉뚱한 책의 책소개가 Brief 에 들어가면 근거 검사가 그것을 "근거 있음" 으로 통과시켜
	 * **틀린 내용의 문항**이 만들어진다. 빈약한 Brief 보다 나쁘므로 없는 편이 낫다.
	 */
	it("찾던 책이 없으면 아무것도 돌려주지 않는다", async () => {
		mockAladin("ItemSearch", { item: [OTHER_BOOK] });
		fetchMock
			.get("https://www.googleapis.com")
			.intercept({ path: (p) => p.startsWith("/books/v1/volumes"), method: "GET" })
			.reply(200, {});

		const records = await lookup(withKey, { title: "마당을 나온 암탉", author: "황선미" });
		expect(records.find((r) => r.source === "aladin")).toBeUndefined();
	});

	/**
	 * 실측에서 잡힌 버그. 표지 OCR 이 ISBN 을 잘못 읽어(『마당을 나온 암탉』 → 9788958281252)
	 * 정확 조회했더니 『즐거움과 상상력을 주는 과학』이 왔고, 그것을 그대로 받아들였다.
	 *
	 * **조회가 정확한 것과 입력이 맞는 것은 다른 문제다.**
	 */
	it("잘못 읽은 ISBN 으로 다른 책이 오면 제목으로 되짚는다", async () => {
		mockAladin("ItemLookUp", { item: [OTHER_BOOK] }); // 잘못된 ISBN → 다른 책
		mockAladin("ItemSearch", { item: [HANARM] }); // 제목으로 되짚어 찾는다
		fetchMock
			.get("https://www.googleapis.com")
			.intercept({ path: (p) => p.startsWith("/books/v1/volumes"), method: "GET" })
			.reply(200, {});
		fetchMock
			.get("https://openlibrary.org")
			.intercept({ path: (p) => p.startsWith("/api/books"), method: "GET" })
			.reply(200, {});

		const records = await lookup(withKey, {
			isbn: "9788958282242",
			title: "마당을 나온 암탉",
			author: "황선미",
		});

		expect(records.find((r) => r.source === "aladin")?.isbn13).toBe("9788971968710");
		expect(records.map((r) => r.title)).not.toContain("마두의 말씨앗");
	});

	/**
	 * 같은 문제가 알라딘만의 것이 아니다. 잘못 읽은 ISBN 으로 Google Books 를 불러도 다른 책이
	 * 온다. 그 결과가 `mergeMetadata` 의 기준점이 되면 제목·저자를 통째로 덮어쓴다.
	 */
	it("다른 소스가 준 엉뚱한 책도 걸러낸다", async () => {
		mockAladin("ItemLookUp", { item: [] });
		mockAladin("ItemSearch", { item: [] });
		fetchMock
			.get("https://www.googleapis.com")
			.intercept({ path: (p) => p.startsWith("/books/v1/volumes"), method: "GET" })
			.reply(200, {
				items: [
					{
						volumeInfo: {
							title: "전혀 다른 책",
							authors: ["다른작가"],
							publisher: "다른출판사",
							industryIdentifiers: [],
						},
					},
				],
			});
		fetchMock
			.get("https://openlibrary.org")
			.intercept({ path: (p) => p.startsWith("/api/books"), method: "GET" })
			.reply(200, {});

		const records = await lookup(withKey, {
			isbn: "9788958282242",
			title: "마당을 나온 암탉",
			author: "황선미",
		});

		expect(records).toEqual([]);
	});

	// 키 만료·할당량 초과·승인 해제가 모두 errorCode 로 온다. 어느 쪽이든 할 수 있는 일이 없다.
	it("오류코드가 오면 조용히 건너뛴다", async () => {
		mockAladin("ItemLookUp", { errorCode: 4, errorMessage: "API출력이 금지된 회원입니다." });
		silenceOthers();

		// 제목이 없으면 되짚을 것도 없다 — ItemSearch 인터셉터를 걸지 않은 것이 그 확인이다.
		const records = await lookup(withKey, { isbn: "9788971968710" });
		expect(records.find((r) => r.source === "aladin")).toBeUndefined();
	});

	it("장애가 나도 다른 소스를 막지 않는다", async () => {
		fetchMock
			.get(ALADIN)
			.intercept({ path: (p) => p.includes("/ItemLookUp.aspx"), method: "GET" })
			.reply(500, "서버 오류");
		fetchMock
			.get("https://www.googleapis.com")
			.intercept({ path: (p) => p.startsWith("/books/v1/volumes"), method: "GET" })
			.reply(200, { items: [{ volumeInfo: { title: "구글 결과", industryIdentifiers: [] } }] });
		fetchMock
			.get("https://openlibrary.org")
			.intercept({ path: (p) => p.startsWith("/api/books"), method: "GET" })
			.reply(200, {});

		const records = await lookup(withKey, { isbn: "9788971968710" });
		expect(records.map((r) => r.source)).toEqual(["google-books"]);
	});

	// 없는 키로 부르면 오류만 늘고 지연만 생긴다.
	it("키가 없으면 알라딘을 부르지 않는다", async () => {
		// 알라딘 인터셉터를 걸지 않았다. 불렀다면 disableNetConnect 로 실패한다.
		silenceOthers();

		const records = await lookup(env, { isbn: "9788971968710" });
		expect(records.find((r) => r.source === "aladin")).toBeUndefined();
	});
});

describe("카카오 책 검색", () => {
	/** 알라딘·구글·오픈라이브러리를 잠재우고 카카오만 본다. */
	function silenceExceptKakao() {
		mockAladin("ItemLookUp", { item: [] });
		mockAladin("ItemSearch", { item: [] });
		fetchMock
			.get("https://www.googleapis.com")
			.intercept({ path: (p) => p.startsWith("/books/v1/volumes"), method: "GET" })
			.reply(200, {})
			.times(1);
		fetchMock
			.get("https://openlibrary.org")
			.intercept({ path: (p) => p.startsWith("/api/books"), method: "GET" })
			.reply(200, {})
			.times(1);
	}

	it("응답을 서지 레코드로 옮긴다", async () => {
		mockKakao({ documents: [KAKAO_HANARM] });
		silenceExceptKakao();

		const records = await lookup(withBoth, {
			isbn: "9788971968710",
			title: "마당을 나온 암탉",
			author: "황선미",
		});
		const kakao = records.find((r) => r.source === "kakao-book");

		expect(kakao).toBeTruthy();
		// `"ISBN10 ISBN13"` 에서 13자리만 골라야 한다.
		expect(kakao!.isbn13).toBe("9788971968710");
		// ISO8601 을 날짜로 자른다.
		expect(kakao!.publishedAt).toBe("2023-07-31");
		expect(kakao!.author).toBe("황선미");
		// 링크의 `&amp;` 도 되돌린다.
		expect(kakao!.url).toContain("&bookId=");
		expect(kakao!.url).not.toContain("&amp;");
		expect(kakao!.description.length).toBeGreaterThan(60);
	});

	// 알라딘과 같은 이유 — ISBN 이 표지 OCR 값이라 믿을 수 없다.
	it("잘못 읽은 ISBN 으로 다른 책이 오면 제목으로 되짚는다", async () => {
		fetchMock
			.get(KAKAO)
			.intercept({ path: (p) => p.includes("target=isbn"), method: "GET" })
			.reply(200, { documents: [{ title: "전혀 다른 책", authors: ["다른작가"], publisher: "다른출판사" }] });
		fetchMock
			.get(KAKAO)
			.intercept({ path: (p) => p.includes("target=title"), method: "GET" })
			.reply(200, { documents: [KAKAO_HANARM] });
		silenceExceptKakao();

		const records = await lookup(withBoth, {
			isbn: "9788958282242",
			title: "마당을 나온 암탉",
			author: "황선미",
		});

		expect(records.find((r) => r.source === "kakao-book")?.isbn13).toBe("9788971968710");
		expect(records.map((r) => r.title)).not.toContain("전혀 다른 책");
	});

	/**
	 * 두 소스가 같은 책을 줘도 **합치지 않는다.** 서로 다른 책소개와 링크를 가진 별개의
	 * 인용이므로, 부모가 두 곳을 확인할 수 있어야 하고 `evidenceWeak` 기준도 그래야 채워진다.
	 */
	it("알라딘과 카카오가 같은 책을 주면 둘 다 남긴다", async () => {
		mockAladin("ItemLookUp", { item: [HANARM] });
		mockKakao({ documents: [KAKAO_HANARM] });
		fetchMock
			.get("https://www.googleapis.com")
			.intercept({ path: (p) => p.startsWith("/books/v1/volumes"), method: "GET" })
			.reply(200, {});
		fetchMock
			.get("https://openlibrary.org")
			.intercept({ path: (p) => p.startsWith("/api/books"), method: "GET" })
			.reply(200, {});

		const records = await lookup(withBoth, { isbn: "9788971968710", title: "마당을 나온 암탉" });

		// 국내 소스가 앞에 온다 — `bib[0]` 를 기준점으로 쓰는 병합이 맞게 돌아야 한다.
		expect(records.map((r) => r.source)).toEqual(["aladin", "kakao-book"]);
	});

	it("키가 없으면 카카오를 부르지 않는다", async () => {
		// 카카오 인터셉터를 걸지 않았다. 불렀다면 disableNetConnect 로 실패한다.
		mockAladin("ItemLookUp", { item: [HANARM] });
		fetchMock
			.get("https://www.googleapis.com")
			.intercept({ path: (p) => p.startsWith("/books/v1/volumes"), method: "GET" })
			.reply(200, {});
		fetchMock
			.get("https://openlibrary.org")
			.intercept({ path: (p) => p.startsWith("/api/books"), method: "GET" })
			.reply(200, {});

		const records = await lookup(withKey, { isbn: "9788971968710", title: "마당을 나온 암탉" });
		expect(records.find((r) => r.source === "kakao-book")).toBeUndefined();
	});
});

describe("조사 1회 = 조회 1회", () => {
	/**
	 * 조사 준비(프롬프트 조립)와 반영(병합·출처 적재)이 **같은 서지 값을 봐야 한다.**
	 * 두 번 부르면 그 사이에 외부 응답이 바뀔 수 있고, 그러면 모델은 A 를 보고 답했는데
	 * 서버는 B 로 제목·저자를 덮어쓴다.
	 *
	 * 인터셉터를 **한 번만** 걸어 두는 것이 그 확인이다 — 두 번 불렀다면
	 * `disableNetConnect` 로 실패한다.
	 */
	it("준비 단계가 적어 둔 서지를 반영 단계가 다시 부르지 않고 읽는다", async () => {
		const { client } = await signupParent();

		fetchMock
			.get("https://api.openai.com")
			.intercept({ path: "/v1/models", method: "GET" })
			.reply(200, { data: [{ id: "gpt-5.6-mini" }] });
		mockOpenAi({ ok: true });
		await client.request("/api/settings/ai-key", {
			method: "PUT",
			body: { provider: "openai", apiKey: "sk-test1234567890abcdefghijklmn" },
		});

		const form = new FormData();
		form.append("cover", new File([PNG], "cover.png", { type: "image/png" }));
		const bookId = (await client.upload("/api/books", form)).body.data.book.id as string;
		await client.patch(`/api/books/${bookId}`, { title: "마당을 나온 암탉", author: "황선미" });

		// 서지 소스는 **각각 한 번만** 응답한다.
		// ISBN 을 모르는 책이라 알라딘은 제목 검색 경로로 간다.
		mockAladin("ItemSearch", { item: [HANARM] });
		mockKakao({ documents: [KAKAO_HANARM] });
		fetchMock
			.get("https://www.googleapis.com")
			.intercept({ path: (p) => p.startsWith("/books/v1/volumes"), method: "GET" })
			.reply(200, {});

		mockOpenAi({
			title: "마당을 나온 암탉",
			author: "황선미",
			publisher: "사계절",
			isbn13: "",
			publishedAt: "2000",
			targetAge: "초등 고학년",
			description: "AI 가 정리한 소개.",
			plotSummary: FIXTURE_PLOT,
			characters: [{ name: "잎싹", role: "암탉" }],
			keyEvents: ["양계장을 떠난다"],
			sources: [],
		});

		const res = await client.post(`/api/books/${bookId}/search`);
		expect(res.status).toBe(200);

		/*
		 * **서지 자료는 참고 자료 목록에 오르지 않는다.**
		 *
		 * 그 목록은 부모가 근거를 훑는 곳이고, 서지 API 의 책소개는 홍보 문구라 출제 근거로
		 * 인정되지 않는다(§7 — `[출판사 소개]` 가 `EVIDENCE_SECTIONS` 에서 빠져 있다).
		 * 서지 정보는 조사 프롬프트에서 "어느 책인지 대조하는 사실" 로 쓰이고 Brief 에도 남는다.
		 *
		 * 여기서 확인하려는 것은 그 위에 있다 — **조사 1회에 조회도 1회.** 인터셉터를 각 소스
		 * 한 번씩만 걸었으므로, 반영 단계가 다시 불렀다면 이 테스트가 깨진다.
		 */
		const detail = await client.get(`/api/books/${bookId}`);
		const sources = detail.body.data.sources.map((s: { source: string }) => s.source);
		expect(sources).not.toContain("aladin");
		expect(sources).not.toContain("kakao-book");

		// 서지가 프롬프트에는 들어갔다는 증거. 캐시에 적혀 있어야 반영 단계가 그것을 읽는다.
		const cached = await env.DB.prepare("SELECT bib_cache FROM books WHERE id = ?")
			.bind(bookId)
			.first<{ bib_cache: string }>();
		const kinds = (JSON.parse(cached!.bib_cache) as { source: string }[]).map((r) => r.source);
		expect(kinds).toContain("aladin");
		expect(kinds).toContain("kakao-book");

		// 줄거리 자료(웹)가 없으니 근거는 얇다. 부모에게 더 꼼꼼히 검수하라고 알린다.
		expect(detail.body.data.evidenceWeak).toBe(true);
	});
});
