import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { normalize, relevantCount, search, type WebSource } from "../src/search/tavily";
import * as budget from "../src/services/search-budget";
import type { AppEnv } from "../src/types";

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

/** 카운터를 깨끗이 지운다. 테스트끼리 섞이면 무엇을 재는지 알 수 없다. */
async function clearCounters(e: AppEnv = env as never) {
	const month = budget.currentMonth();
	for (const n of [1, 2, 3, 4]) {
		await e.SESSIONS.delete(n === 1 ? `tavily:${month}` : `tavily:${month}:${n}`);
	}
}

/**
 * 키 구성을 **명시적으로** 세운다.
 *
 * `{ ...env }` 만 하면 `.dev.vars` 의 실제 키가 딸려 들어온다. 그러면 "키가 하나일 때"
 * 를 재려는 테스트가 개발자 환경에 따라 넷이 되어 조용히 다른 것을 잰다.
 */
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
const fourKeys = withKeys("tvly-a", "tvly-b", "tvly-c", "tvly-d");

describe("월 크레딧 예산", () => {
	// 무료 등급은 계정당 월 1,000 이고 그것은 조용히 넘길 수 있는 숫자다.
	it("상한을 넘기면 잡아 주지 않는다", async () => {
		await clearCounters();
		const month = budget.currentMonth();
		await env.SESSIONS.put(`tavily:${month}`, String(budget.MONTHLY_CAP - 1));

		// 1 은 들어가고 2 는 안 들어간다.
		expect(await budget.reserve(oneKey, 2)).toBeNull();
		expect(await budget.reserve(oneKey, 1)).not.toBeNull();
		expect(await budget.spent(oneKey)).toBe(budget.MONTHLY_CAP);
		expect(await budget.remaining(oneKey)).toBe(0);

		await clearCounters();
	});

	it("쓴 만큼 쌓인다", async () => {
		await clearCounters();

		expect(await budget.reserve(oneKey, 2)).not.toBeNull();
		expect(await budget.reserve(oneKey, 1)).not.toBeNull();
		expect(await budget.spent(oneKey)).toBe(3);

		await clearCounters();
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
		const row = await requireOwned(noKeys, userId, bookId);

		const out = await prepareWeb(noKeys, userId, row);
		expect(out).toEqual([]);
		// 인터셉터를 걸지 않았는데 통과했다 = 외부를 부르지 않았다.
	});

	it("재검색은 거절한다", async () => {
		const { bookId, userId } = await aBook();
		await expect(refreshWeb(noKeys, userId, bookId)).rejects.toThrow();
	});
});

describe("캐시", () => {
	// 여기가 크레딧을 지키는 장치다. 아이가 5번 재도전해도 책은 그대로다.
	it("두 번째 준비는 검색하지 않는다", async () => {
		const { bookId, userId } = await aBook();
		const e = withKeys("tvly-test");

		mockTavily(PAGES, 1); // 딱 한 번만 허용한다
		const first = await prepareWeb(e, userId, await requireOwned(e, userId, bookId));
		expect(first.length).toBeGreaterThan(0);

		// 두 번째는 인터셉터가 없다 — 부르면 테스트가 깨진다.
		const second = await prepareWeb(e, userId, await requireOwned(e, userId, bookId));
		expect(second).toHaveLength(first.length);
	});

	it("빈손이어도 횟수를 세서 매번 다시 부르지 않는다", async () => {
		const { bookId, userId } = await aBook();
		const e = withKeys("tvly-test");

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
		const e = withKeys("tvly-test");

		await booksRepo.update(e, userId, bookId, { web_searches: budget.MAX_SEARCHES_PER_BOOK });
		await expect(refreshWeb(e, userId, bookId)).rejects.toThrow(/횟수/);
	});

	it("남은 횟수를 함께 알려준다", async () => {
		const { bookId, userId } = await aBook();
		const e = withKeys("tvly-test");

		mockTavily(PAGES, 1);
		const out = await refreshWeb(e, userId, bookId);

		expect(out.sourceCount).toBeGreaterThan(0);
		expect(out.searchesLeft).toBe(budget.MAX_SEARCHES_PER_BOOK - 1);
		expect(out.notice).toBeNull();
	});

	// 새 검색이 빈손이면 이전에 찾아 둔 자료를 잃어서는 안 된다.
	it("빈손 재검색이 기존 자료를 지우지 않는다", async () => {
		const { bookId, userId } = await aBook();
		const e = withKeys("tvly-test");

		mockTavily(PAGES, 1);
		await refreshWeb(e, userId, bookId);

		mockTavily([], 2); // basic 빈손 → advanced 도 빈손
		const out = await refreshWeb(e, userId, bookId);

		expect(out.sourceCount).toBeGreaterThan(0);
		expect(out.notice).toContain("직접");
		expect(cachedWeb(await requireOwned(e, userId, bookId)).length).toBeGreaterThan(0);
	});
});

/* ── 키 여러 개 순차 사용 ────────────────────────────── */

describe("키 여러 개", () => {
	// 무료 등급은 계정당 월 1,000 이다. 계정을 넷 두면 풀도 넷이다.
	it("키마다 독립된 풀을 갖는다", async () => {
		await clearCounters();

		expect(await budget.remaining(oneKey)).toBe(budget.MONTHLY_CAP);
		expect(await budget.remaining(fourKeys)).toBe(budget.MONTHLY_CAP * 4);
	});

	it("번호 순서대로 쓴다", async () => {
		await clearCounters();

		const first = await budget.reserve(fourKeys, 1);
		expect(first?.index).toBe(1);
		expect(first?.key).toBe("tvly-a");

		// 1번이 아직 남아 있으면 계속 1번이다. 굳이 흩뿌리지 않는다.
		expect((await budget.reserve(fourKeys, 1))?.index).toBe(1);

		await clearCounters();
	});

	it("앞 키가 바닥나면 다음 키로 넘어간다", async () => {
		await clearCounters();
		const month = budget.currentMonth();
		await env.SESSIONS.put(`tavily:${month}`, String(budget.MONTHLY_CAP));

		const slot = await budget.reserve(fourKeys, 2);
		expect(slot?.index).toBe(2);
		expect(slot?.key).toBe("tvly-b");

		await clearCounters();
	});

	it("전부 바닥나면 아무것도 주지 않는다", async () => {
		await clearCounters();
		const month = budget.currentMonth();
		for (const n of [1, 2, 3, 4]) {
			await env.SESSIONS.put(n === 1 ? `tavily:${month}` : `tavily:${month}:${n}`, String(budget.MONTHLY_CAP));
		}

		expect(await budget.reserve(fourKeys, 1)).toBeNull();
		expect(await budget.remaining(fourKeys)).toBe(0);

		await clearCounters();
	});

	// 중간 키를 지웠을 때 뒤엣것이 통째로 안 쓰이면 설명할 수 없다.
	it("중간이 비어 있어도 있는 것만 추린다", async () => {
		const gapped = withKeys("tvly-a", undefined, "tvly-c");
		expect(budget.slots(gapped).map((s) => s.index)).toEqual([1, 3]);
	});

	/**
	 * 1번만 옛 카운터 이름을 쓴다. 키를 여럿으로 늘리면서 이름을 바꿨다면 그 달에 이미 쓴
	 * 크레딧이 0 으로 보여 한도를 넘긴다.
	 */
	it("1번 키의 카운터 이름이 그대로다", async () => {
		await clearCounters();
		await env.SESSIONS.put(`tavily:${budget.currentMonth()}`, "100");

		expect(await budget.spentOn(oneKey, 1)).toBe(100);
		await clearCounters();
	});
});

describe("Tavily 가 소진을 알려올 때", () => {
	function mockStatus(status: number, times = 1) {
		fetchMock
			.get("https://api.tavily.com")
			.intercept({ path: "/search", method: "POST" })
			.reply(status, { detail: { error: "limit" } })
			.times(times);
	}

	/**
	 * 우리 카운터는 적게 셀 수 있다 — KV 경쟁, 이 앱 바깥에서의 사용. 그러면 남은 달 내내
	 * 같은 키로 432 를 받는다. Tavily 의 신호를 믿고 그 키를 접는다.
	 */
	it("432 를 받으면 그 키를 접고 다음 키로 간다", async () => {
		await clearCounters();

		mockStatus(432, 1); // 1번 키
		mockTavily(PAGES, 1); // 2번 키

		const out = await search(fourKeys, { title: "움푹산의 비밀", author: "천희순" });
		expect(out.length).toBeGreaterThan(0);

		// 1번은 소진으로 표시됐고 2번은 1 크레딧만 썼다.
		expect(await budget.spentOn(fourKeys, 1)).toBe(budget.MONTHLY_CAP);
		expect(await budget.spentOn(fourKeys, 2)).toBe(1);

		await clearCounters();
	});

	// 429 는 분당 레이트리밋이라 잠시 뒤면 풀린다. 이걸로 키를 버리면 그 달 내내 못 쓴다.
	it("429 로는 키를 접지 않는다", async () => {
		await clearCounters();

		// basic 이 429 → 빈손, 관련 결과 부족이라 advanced 로 한 번 더 → 또 429
		mockStatus(429, 2);

		const out = await search(fourKeys, { title: "움푹산의 비밀", author: "천희순" });
		expect(out).toEqual([]);
		expect(await budget.spentOn(fourKeys, 1)).toBeLessThan(budget.MONTHLY_CAP);

		await clearCounters();
	});

	/**
	 * basic 이 네 키를 모두 태우고 나면 advanced 는 **한 번도 부르지 않는다.**
	 * 예산이 이미 0 이라 `reserve` 가 잡아 주지 않기 때문이다 — 호출을 4번만 하고 접는다.
	 */
	it("모든 키가 432 면 4번만 부르고 접는다", async () => {
		await clearCounters();
		mockStatus(432, 4);

		const out = await search(fourKeys, { title: "움푹산의 비밀", author: "천희순" });
		expect(out).toEqual([]);
		expect(await budget.remaining(fourKeys)).toBe(0);
		// 인터셉터가 딱 4번 소진됐다 = 그 이상 부르지 않았다(afterEach 가 확인한다).

		await clearCounters();
	});
});
