import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { isSameBook, lookup } from "../src/search/bibliographic";

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
	// 태그 안에 ASP 블록이 중첩된 실제 형태. 순서를 잘못 지우면 `">` 가 남는다.
	description:
		'<a href="/catalog/book.asp?ISBN=8901028514&UID=<% =qsUID %>">&lt;나쁜 어린이표&gt;</a>로 아이들만의 생각을 &amp; 절묘하게 표현해냈던 황선미의 장편동화.',
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
		expect(aladin!.description).toContain("<나쁜 어린이표>로");
		expect(aladin!.description).toContain("생각을 & 절묘하게");
		// ASP 블록 때문에 남던 찌꺼기. 실측에서 `">로 아이들만의…` 로 보였다.
		expect(aladin!.description.startsWith('">')).toBe(false);
		expect(aladin!.description).not.toContain("%>");
		expect(aladin!.description).toMatch(/^<나쁜 어린이표>로/);
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
