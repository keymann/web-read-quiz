import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { normalize, relevantCount, type WebSource } from "../src/search/tavily";
import * as budget from "../src/services/search-budget";

/**
 * Tavily 웹 검색 (§docs/tavily-search-plan.md).
 *
 * 여기서 지키려는 것은 두 가지다 — **크레딧이 새지 않는 것**과, 키가 없을 때 지금 동작이
 * 그대로 남는 것. 검색 품질은 테스트로 잴 수 없어 Phase 0 실측으로 남겼다.
 */

const source = (over: Partial<WebSource> = {}): WebSource => ({
	url: "https://blog.example.com/a",
	title: "움푹산의 비밀 서평",
	content: "거인 크네가 움푹산의 아이들을 구해 낸 이야기",
	score: 0.8,
	...over,
});

describe("응답 정규화", () => {
	it("관련 구간과 원문을 이어 붙인다", () => {
		const [out] = normalize([
			{ url: "https://a.example/x", title: "제목", content: "관련 구간", raw_content: "페이지 전문", score: 0.9 },
		]);
		// content 를 앞에 둔다 — 상한에 먼저 들어가야 한다.
		expect(out.content).toBe("관련 구간 페이지 전문");
	});

	// 화면에 링크로 붙는 값이다. `javascript:` 가 섞이면 누르는 순간 우리 오리진에서 실행된다.
	it("http(s) 가 아닌 주소는 버린다", () => {
		const out = normalize([
			{ url: "javascript:alert(1)", content: "나쁜 것" },
			{ url: "data:text/html,<script>", content: "나쁜 것" },
			{ url: "https://ok.example/x", content: "괜찮은 것" },
		]);
		expect(out).toHaveLength(1);
		expect(out[0]!.url).toBe("https://ok.example/x");
	});

	it("같은 URL 은 한 번만", () => {
		const out = normalize([
			{ url: "https://a.example/x", content: "처음" },
			{ url: "https://a.example/x", content: "두 번째" },
		]);
		expect(out).toHaveLength(1);
	});

	it("내용이 빈 결과는 버린다", () => {
		expect(normalize([{ url: "https://a.example/x", content: "   ", raw_content: "" }])).toHaveLength(0);
	});

	it("관련도 높은 것부터 정렬한다", () => {
		const out = normalize([
			{ url: "https://a.example/1", content: "가", score: 0.3 },
			{ url: "https://a.example/2", content: "나", score: 0.9 },
		]);
		expect(out.map((s) => s.score)).toEqual([0.9, 0.3]);
	});

	it("긴 원문은 잘라 둔다", () => {
		const [out] = normalize([{ url: "https://a.example/x", raw_content: "가".repeat(5_000) }]);
		expect(out.content.length).toBeLessThanOrEqual(2_000);
	});
});

describe("이 책을 다룬 결과인지", () => {
	/**
	 * Phase 0 실측(basic, 결과 20건 기준)에서 실제 책은 6건 이상, 웹에 자료가 없는 책은
	 * 0건이었다. 그 사이를 가르는 판정이다.
	 */
	it("제목이 담긴 결과만 센다", () => {
		const sources = [
			source(),
			source({ url: "https://b.example/y", title: "전혀 다른 글", content: "고양이 사료 후기" }),
		];
		expect(relevantCount(sources, "움푹산의 비밀")).toBe(1);
	});

	// 문자열 포함으로 세면 『Dirty Bertie PONG!』이 0 이 된다 — 페이지는 "Dirty Bertie: Pong!"
	// 으로 쓴다. 어간 대조(`groundedRatio`)는 그것을 넘는다.
	it("부제 표기가 달라도 센다", () => {
		const sources = [
			source({ title: "Dirty Bertie: Pong! review", content: "Bertie and Darren and Eugene" }),
		];
		expect(relevantCount(sources, "Dirty Bertie PONG!")).toBe(1);
	});
});

describe("월 크레딧 예산", () => {
	// 무료 등급은 월 1,000 이고 그것은 조용히 넘길 수 있는 숫자다.
	it("상한을 넘기면 잡아 주지 않는다", async () => {
		const month = budget.currentMonth();
		await env.SESSIONS.put(`tavily:${month}`, String(budget.MONTHLY_CAP - 1));

		// 1 은 들어가고 2 는 안 들어간다.
		expect(await budget.reserve(env, 2)).toBe(false);
		expect(await budget.reserve(env, 1)).toBe(true);
		expect(await budget.spent(env)).toBe(budget.MONTHLY_CAP);
		expect(await budget.remaining(env)).toBe(0);

		await env.SESSIONS.delete(`tavily:${month}`);
	});

	it("쓴 만큼 쌓인다", async () => {
		const month = budget.currentMonth();
		await env.SESSIONS.delete(`tavily:${month}`);

		expect(await budget.reserve(env, 2)).toBe(true);
		expect(await budget.reserve(env, 1)).toBe(true);
		expect(await budget.spent(env)).toBe(3);

		await env.SESSIONS.delete(`tavily:${month}`);
	});

	// 부모가 보는 달과 카운터가 어긋나면 "이달 한도" 를 설명할 수 없다.
	it("달은 KST 로 센다", () => {
		// 2026-08-31 20:00 UTC = 2026-09-01 05:00 KST
		expect(budget.currentMonth(new Date("2026-08-31T20:00:00Z"))).toBe("2026-09");
		expect(budget.currentMonth(new Date("2026-08-31T14:00:00Z"))).toBe("2026-08");
	});

	// 상한이 1,000 이 아닌 이유: KV 는 원자적이지 않아 조금 새고, 개발용 호출이 부모의
	// 조사를 굶겨서는 안 된다.
	it("무료 한도보다 낮게 잡혀 있다", () => {
		expect(budget.MONTHLY_CAP).toBeLessThan(budget.FREE_TIER_CREDITS);
	});
});

/* ── 책 화면과의 연결 ────────────────────────────────── */

import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll } from "vitest";
import { Client, signupParent } from "./helpers";
import * as booksRepo from "../src/repositories/books";
import { refreshWeb, prepareWeb, cachedWeb, requireOwned } from "../src/services/book";

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function aBook(): Promise<{ client: Client; bookId: string; userId: string }> {
	const { client } = await signupParent();
	const form = new FormData();
	form.append("cover", new File([PNG], "cover.png", { type: "image/png" }));
	const created = await client.upload("/api/books", form);
	const bookId = created.body.data.book.id;
	await client.request(`/api/books/${bookId}`, {
		method: "PATCH",
		body: { title: "움푹산의 비밀", author: "천희순" },
	});
	const owner = await env.DB.prepare("SELECT created_by FROM books WHERE id = ?")
		.bind(bookId)
		.first<{ created_by: string }>();
	return { client, bookId, userId: owner!.created_by };
}

function mockTavily(results: unknown[], times = 1) {
	fetchMock
		.get("https://api.tavily.com")
		.intercept({ path: "/search", method: "POST" })
		.reply(200, { results })
		.times(times);
}

const PAGES = Array.from({ length: 8 }, (_, i) => ({
	url: `https://blog.example.com/${i}`,
	title: `움푹산의 비밀 서평 ${i}`,
	content: "거인 크네가 움푹산의 아이들을 구해 낸 이야기",
	raw_content: "마을 사람들은 크네를 무서워했지만 크네는 아이들을 구했다.",
	score: 0.9 - i * 0.01,
}));

describe("키가 없을 때", () => {
	/**
	 * 알라딘을 붙일 때와 같은 규칙 — 키가 없으면 조용히 건너뛰고 지금 동작이 그대로 남는다.
	 * 이걸 어기면 키를 아직 안 넣은 환경에서 조사가 통째로 멈춘다.
	 */
	it("검색하지 않고 빈 배열을 준다", async () => {
		const { bookId, userId } = await aBook();
		const row = await requireOwned({ ...env, TAVILY_API_KEY: undefined } as never, userId, bookId);

		const out = await prepareWeb({ ...env, TAVILY_API_KEY: undefined } as never, userId, row);
		expect(out).toEqual([]);
		// 인터셉터를 걸지 않았는데 통과했다 = 외부를 부르지 않았다.
	});

	it("재검색은 거절한다", async () => {
		const { bookId, userId } = await aBook();
		await expect(
			refreshWeb({ ...env, TAVILY_API_KEY: undefined } as never, userId, bookId),
		).rejects.toThrow();
	});
});

describe("캐시", () => {
	// 여기가 크레딧을 지키는 장치다. 아이가 5번 재도전해도 책은 그대로다.
	it("두 번째 준비는 검색하지 않는다", async () => {
		const { bookId, userId } = await aBook();
		const e = { ...env, TAVILY_API_KEY: "tvly-test" } as never;

		mockTavily(PAGES, 1); // 딱 한 번만 허용한다
		const first = await prepareWeb(e, userId, await requireOwned(e, userId, bookId));
		expect(first.length).toBeGreaterThan(0);

		// 두 번째는 인터셉터가 없다 — 부르면 테스트가 깨진다.
		const second = await prepareWeb(e, userId, await requireOwned(e, userId, bookId));
		expect(second).toHaveLength(first.length);
	});

	it("빈손이어도 횟수를 세서 매번 다시 부르지 않는다", async () => {
		const { bookId, userId } = await aBook();
		const e = { ...env, TAVILY_API_KEY: "tvly-test" } as never;

		// 관련 결과가 없으면 basic → advanced 로 한 번 더 간다. 그래서 두 번.
		mockTavily([], 2);
		expect(await prepareWeb(e, userId, await requireOwned(e, userId, bookId))).toEqual([]);

		// 두 번째 준비는 아예 부르지 않는다.
		expect(await prepareWeb(e, userId, await requireOwned(e, userId, bookId))).toEqual([]);
	});
});

describe("재검색 상한", () => {
	it("책당 횟수를 다 쓰면 거절한다", async () => {
		const { bookId, userId } = await aBook();
		const e = { ...env, TAVILY_API_KEY: "tvly-test" } as never;

		await booksRepo.update(e, userId, bookId, { web_searches: budget.MAX_SEARCHES_PER_BOOK });
		await expect(refreshWeb(e, userId, bookId)).rejects.toThrow(/횟수/);
	});

	it("남은 횟수를 함께 알려준다", async () => {
		const { bookId, userId } = await aBook();
		const e = { ...env, TAVILY_API_KEY: "tvly-test" } as never;

		mockTavily(PAGES, 1);
		const out = await refreshWeb(e, userId, bookId);

		expect(out.sourceCount).toBeGreaterThan(0);
		expect(out.searchesLeft).toBe(budget.MAX_SEARCHES_PER_BOOK - 1);
		expect(out.notice).toBeNull();
	});

	// 새 검색이 빈손이면 이전에 찾아 둔 자료를 잃어서는 안 된다.
	it("빈손 재검색이 기존 자료를 지우지 않는다", async () => {
		const { bookId, userId } = await aBook();
		const e = { ...env, TAVILY_API_KEY: "tvly-test" } as never;

		mockTavily(PAGES, 1);
		await refreshWeb(e, userId, bookId);

		mockTavily([], 2); // basic 빈손 → advanced 도 빈손
		const out = await refreshWeb(e, userId, bookId);

		expect(out.sourceCount).toBeGreaterThan(0);
		expect(out.notice).toContain("직접");
		expect(cachedWeb(await requireOwned(e, userId, bookId)).length).toBeGreaterThan(0);
	});
});
