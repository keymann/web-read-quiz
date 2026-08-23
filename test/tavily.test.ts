import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	buildQuery,
	merge,
	normalize,
	plotRelated,
	relevantCount,
	search,
	type WebSource,
} from "../src/search/tavily";
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

/**
 * 모아 두는 자료의 순서와 상한 (§tavily.merge).
 *
 * 순서가 곧 프롬프트에 실릴 순서다. 판매 페이지가 관련도만 높아 앞자리를 차지하면 정작
 * 줄거리를 담은 글이 상한 밖으로 밀린다.
 */
describe("자료를 모으는 규칙", () => {
	const plotPage = (i: number, score: number): WebSource => ({
		url: `https://blog.example.com/${i}`,
		title: `움푹산의 비밀 서평 ${i}`,
		content: "거인 크네의 줄거리와 등장인물, 결말까지 적은 독후감",
		score,
	});
	const shopPage = (i: number, score: number): WebSource => ({
		url: `https://shop.example.com/${i}`,
		title: "움푹산의 비밀 - 인터넷 서점",
		content: "정가 13,000원 배송 무료 장바구니 담기 적립",
		score,
	});

	it("줄거리를 다룬 글을 앞에 세운다", () => {
		// 판매 페이지가 관련도는 더 높다.
		const out = merge([plotPage(1, 0.3)], [shopPage(2, 0.99)]);
		expect(out.map((s) => s.url)).toEqual([
			"https://blog.example.com/1",
			"https://shop.example.com/2",
		]);
	});

	it("같은 앞자리 안에서는 관련도로 줄 세운다", () => {
		const out = merge([plotPage(1, 0.5)], [plotPage(2, 0.9)]);
		expect(out.map((s) => s.score)).toEqual([0.9, 0.5]);
	});

	// 같은 주소는 한 번만. 새로 받은 발췌를 남긴다 — 페이지가 그동안 늘어났을 수 있다.
	it("같은 주소는 새로 받은 것을 남긴다", () => {
		const older = { ...plotPage(1, 0.5), content: "옛 발췌" };
		const newer = { ...plotPage(1, 0.5), content: "새 발췌" };

		const out = merge([older], [newer]);
		expect(out).toHaveLength(1);
		expect(out[0]!.content).toBe("새 발췌");
	});

	/**
	 * 검색 한 번이 20건을 물어다 주고 책당 여섯 번까지 쓸 수 있다. 그냥 쌓으면 120건 ·
	 * 240KB 가 되고 조사와 문제 생성이 그 행을 매번 읽는다.
	 */
	it("상한을 넘겨 쌓지 않는다", () => {
		const many = Array.from({ length: 40 }, (_, i) => plotPage(i, 0.9 - i * 0.01));
		const out = merge([], many);

		expect(out).toHaveLength(24);
		// 잘려 나가는 것은 관련도가 낮은 뒤쪽이다.
		expect(out[0]!.score).toBeCloseTo(0.9);
	});
});

describe("참고 자료로 올릴 자료인지", () => {
	/**
	 * 검색은 20건을 물어다 주는데 절반 이상이 판매 페이지·도서관 목록이다. 그것까지 참고 자료로
	 * 쌓으면 부모는 정가·배송·장바구니만 적힌 발췌를 스무 개 훑어야 한다.
	 *
	 * 판매 페이지도 제목은 정확히 담고 있어 제목 대조만으로는 걸러지지 않는다. 그래서 줄거리를
	 * 다루는 낱말을 함께 본다.
	 */
	it("판매·목록 정보뿐인 자료는 뺀다", () => {
		const sources = [
			source(),
			source({
				url: "https://shop.example.com/p/1",
				title: "움푹산의 비밀 - 인터넷 서점",
				content:
					"움푹산의 비밀 정가 13,000원 판매가 11,700원 10% 적립 650원 배송 무료 장바구니 담기 바로구매 판매지수 1,240 재고 있음",
			}),
		];

		const kept = plotRelated(sources, "움푹산의 비밀");
		expect(kept).toHaveLength(1);
		expect(kept[0]!.url).toBe("https://blog.example.com/a");
	});

	it("다른 책을 다룬 자료는 뺀다", () => {
		const sources = [
			source({ url: "https://blog.example.com/b", title: "고양이 사료 후기", content: "줄거리 주인공 결말" }),
		];
		expect(plotRelated(sources, "움푹산의 비밀")).toEqual([]);
	});

	// 서점 상세 페이지의 책소개는 홍보 문구지만 줄거리 조각을 담고 있다. 그건 남긴다 —
	// 거르려는 것은 "책 내용이 없는 자료" 이고 "서점" 이 아니다.
	it("책소개가 실린 서점 페이지는 남긴다", () => {
		const sources = [
			source({
				url: "https://shop.example.com/p/2",
				title: "움푹산의 비밀 - 인터넷 서점",
				content: "책소개 거인 크네가 주인공이 되어 움푹산 아이들을 구해 내는 이야기. 정가 13,000원 배송 무료",
			}),
		];
		expect(plotRelated(sources, "움푹산의 비밀")).toHaveLength(1);
	});
});

/** 카운터를 깨끗이 지운다. 테스트끼리 섞이면 무엇을 재는지 알 수 없다. */
async function clearCounters(e: AppEnv = env as never) {
	const month = budget.currentMonth();
	for (const n of [1, 2, 3, 4]) {
		await e.SESSIONS.delete(n === 1 ? `tavily:${month}` : `tavily:${month}:${n}`);
	}
	// 잔량 조회 캐시도 지운다. 남아 있으면 다음 테스트가 앞 테스트의 숫자를 본다.
	await e.SESSIONS.delete("tavily:usage");
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

/**
 * 부모에게 보여줄 잔량은 **우리 카운터가 아니라 Tavily 가 아는 값**이다.
 *
 * 카운터는 막는 데 쓰는 값이라 실제와 어긋난다. KV 경쟁으로 새고, 이 앱 바깥에서 같은 키를
 * 쓰면 아예 세지 못한다. 2026-08-22 실측에서 우리 표시는 한도가 3,800 이라고 했지만 실제
 * 한도는 네 계정 × 1,000 = 4,000 이었다.
 */
describe("남은 크레딧", () => {
	function mockUsage(planUsage: number, planLimit: number | null, times = 1) {
		fetchMock
			.get("https://api.tavily.com")
			.intercept({ path: "/usage", method: "GET" })
			.reply(200, { account: { plan_usage: planUsage, plan_limit: planLimit } })
			.times(times);
	}

	it("Tavily 가 아는 값을 그대로 쓴다", async () => {
		await clearCounters(oneKey);

		mockUsage(98, 1000);
		expect(await budget.refreshUsage(oneKey)).toEqual({ used: 98, limit: 1000, measured: true });

		await clearCounters(oneKey);
	});

	// 키마다 딸린 계정이 다르다. 한도도 사용량도 합쳐야 서비스 전체의 잔량이 된다.
	it("키가 여럿이면 계정마다 물어 합친다", async () => {
		await clearCounters(fourKeys);

		mockUsage(25, 1000, 4);
		expect(await budget.refreshUsage(fourKeys)).toEqual({ used: 100, limit: 4000, measured: true });

		await clearCounters(fourKeys);
	});

	/**
	 * 못 물어본 키는 우리 카운터로 메운다. 한 키가 응답하지 않는다고 전체 숫자를 감추면
	 * 부모는 얼마 남았는지 알 수 없다. 대신 짐작이라고 밝힌다.
	 */
	it("못 물어보면 카운터로 짐작하고 그렇다고 밝힌다", async () => {
		await clearCounters(oneKey);
		await env.SESSIONS.put(`tavily:${budget.currentMonth()}`, "40");

		fetchMock
			.get("https://api.tavily.com")
			.intercept({ path: "/usage", method: "GET" })
			.reply(401, { detail: "unauthorized" });

		expect(await budget.refreshUsage(oneKey)).toEqual({
			used: 40,
			limit: budget.MONTHLY_CAP,
			measured: false,
		});

		await clearCounters(oneKey);
	});

	/**
	 * 화면이 부르는 쪽은 **외부를 부르지 않는다.** 물어보는 데 실측 1.5초가 걸려서, 책 화면을
	 * 열 때마다 그만큼 기다리게 할 수 없다.
	 */
	it("화면 조회는 들고 있던 값을 그대로 내준다", async () => {
		await clearCounters(oneKey);

		mockUsage(7, 1000); // refreshUsage 한 번만 허용한다
		await budget.refreshUsage(oneKey);

		// 인터셉터가 없다 — usage() 가 외부를 부르면 테스트가 깨진다.
		const out = await budget.usage(oneKey);
		expect(out.used).toBe(7);
		expect(out.limit).toBe(1000);
		expect(out.stale).toBe(false);

		await clearCounters(oneKey);
	});

	/**
	 * 묵으면 다시 물을 때가 됐다고 알린다. 그 갱신은 응답 뒤에서 돈다.
	 *
	 * 기준 시간을 여기 적어 두지 않고 상수를 가져다 쓴다. 값을 두 곳에 적으면 한쪽을 고쳤을 때
	 * 이 테스트가 조용히 어긋난다 — 실제로 그렇게 깨졌다(5분 → 30분으로 늘렸을 때).
	 */
	it("묵은 값은 다시 물으라고 알린다", async () => {
		await clearCounters(oneKey);

		mockUsage(7, 1000);
		const at = 1_000_000;
		await budget.refreshUsage(oneKey, at);

		const fresh = at + budget.USAGE_STALE_MS / 2;
		const stale = at + budget.USAGE_STALE_MS + 1_000;

		expect((await budget.usage(oneKey, fresh)).stale).toBe(false);
		expect((await budget.usage(oneKey, stale)).stale).toBe(true);

		await clearCounters(oneKey);
	});

	// 아직 한 번도 못 물어본 상태. 짐작한 값이라도 내주고 갱신을 맡긴다.
	it("들고 있는 값이 없으면 짐작한 값을 내주고 갱신을 맡긴다", async () => {
		await clearCounters(oneKey);
		await env.SESSIONS.put(`tavily:${budget.currentMonth()}`, "12");

		const out = await budget.usage(oneKey);
		expect(out).toEqual({ used: 12, limit: budget.MONTHLY_CAP, measured: false, stale: true });

		await clearCounters(oneKey);
	});

	it("키가 없으면 묻지 않는다", async () => {
		expect(await budget.usage(noKeys)).toEqual({
			used: 0,
			limit: 0,
			measured: false,
			stale: false,
		});
	});
});

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
import { applyResearch, prepareWeb, cachedWeb, requireOwned } from "../src/services/book";

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

	it("다시 찾기도 외부를 부르지 않는다", async () => {
		const { bookId, userId } = await aBook();
		await asResearched(noKeys, userId, bookId);

		const out = await prepareWeb(noKeys, userId, await requireOwned(noKeys, userId, bookId));
		expect(out).toEqual([]);
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

/**
 * 이미 한 번 조사한 책으로 만든다. `prepareWeb` 은 이 표시를 보고 "부모가 정보 다시 찾기를
 * 눌렀다" 고 판단한다.
 */
async function asResearched(e: AppEnv, userId: string, bookId: string): Promise<void> {
	await booksRepo.update(e, userId, bookId, { searched_at: new Date().toISOString() });
}

describe("정보 다시 찾기", () => {
	// 질의 사다리가 시도마다 다른 말로 묻는다. 다시 찾기가 검색하지 않으면 그 사다리를 쓸 곳이 없다.
	it("다시 찾기는 웹을 새로 검색한다", async () => {
		const { bookId, userId } = await aBook();
		const e = withKeys("tvly-test");

		mockTavily(PAGES, 1);
		await prepareWeb(e, userId, await requireOwned(e, userId, bookId));
		await asResearched(e, userId, bookId);

		// 두 번째 인터셉터를 걸었다 = 다시 찾기는 실제로 검색해야 한다.
		mockTavily(PAGES, 1);
		const out = await prepareWeb(e, userId, await requireOwned(e, userId, bookId));

		expect(out.length).toBeGreaterThan(0);
		expect((await requireOwned(e, userId, bookId)).web_searches).toBe(2);
	});

	/**
	 * 한 번의 조사가 조사 계획을 여러 번 세울 수 있다(모델 교체 · 내장 검색 429).
	 * 그때마다 검색하면 부모가 버튼을 한 번 눌렀는데 크레딧이 두세 번 나간다.
	 */
	it("한 조사 안에서 두 번 찾지 않는다", async () => {
		const { bookId, userId } = await aBook();
		const e = withKeys("tvly-test");
		await asResearched(e, userId, bookId);

		mockTavily(PAGES, 1); // 딱 한 번만 허용한다
		const first = await prepareWeb(e, userId, await requireOwned(e, userId, bookId));
		expect(first.length).toBeGreaterThan(0);

		// 인터셉터가 없다 — 부르면 테스트가 깨진다.
		const second = await prepareWeb(e, userId, await requireOwned(e, userId, bookId));
		expect(second).toHaveLength(first.length);
	});

	it("책당 횟수를 다 쓰면 더 찾지 않고 찾아 둔 자료를 쓴다", async () => {
		const { bookId, userId } = await aBook();
		const e = withKeys("tvly-test");

		mockTavily(PAGES, 1);
		const before = await prepareWeb(e, userId, await requireOwned(e, userId, bookId));

		await booksRepo.update(e, userId, bookId, { web_searches: budget.MAX_SEARCHES_PER_BOOK });
		await asResearched(e, userId, bookId);

		// 인터셉터가 없다. 상한을 넘겨 부르면 테스트가 깨진다.
		const out = await prepareWeb(e, userId, await requireOwned(e, userId, bookId));
		expect(out).toHaveLength(before.length);
	});

	/**
	 * 다시 찾기는 **모으는 것**이다. 질의 사다리가 시도마다 다른 말로 물으므로 검색마다
	 * 걸리는 페이지가 다르다. 새것으로 덮으면 지난번에 건진 독후감을 잃는다.
	 */
	it("다시 찾은 자료를 이전 자료에 더한다", async () => {
		const { bookId, userId } = await aBook();
		const e = withKeys("tvly-test");

		mockTavily(PAGES, 1);
		const first = await prepareWeb(e, userId, await requireOwned(e, userId, bookId));
		await asResearched(e, userId, bookId);

		// 주소가 겹치지 않는 다른 페이지가 걸린다.
		const MORE = PAGES.map((page, i) => ({ ...page, url: `https://cafe.example.com/${i}` }));
		mockTavily(MORE, 1);
		const pooled = await prepareWeb(e, userId, await requireOwned(e, userId, bookId));

		expect(pooled.length).toBe(first.length + MORE.length);
		// 적어 둔 것도 합쳐진 것이어야 한다. 다음 조사가 이걸 읽는다.
		expect(cachedWeb(await requireOwned(e, userId, bookId))).toHaveLength(pooled.length);
	});

	// 같은 주소는 한 번만. 사다리를 올려도 같은 페이지가 다시 걸리는 일이 흔하다.
	it("같은 주소는 한 번만 남는다", async () => {
		const { bookId, userId } = await aBook();
		const e = withKeys("tvly-test");

		mockTavily(PAGES, 1);
		const first = await prepareWeb(e, userId, await requireOwned(e, userId, bookId));
		await asResearched(e, userId, bookId);

		mockTavily(PAGES, 1); // 똑같은 결과가 다시 온다
		const pooled = await prepareWeb(e, userId, await requireOwned(e, userId, bookId));

		expect(pooled).toHaveLength(first.length);
	});

	// 이번 질의가 못 건졌다고 지난번에 건진 근거를 버릴 이유가 없다.
	it("빈손으로 돌아와도 찾아 둔 자료를 잃지 않는다", async () => {
		const { bookId, userId } = await aBook();
		const e = withKeys("tvly-test");

		mockTavily(PAGES, 1);
		const before = await prepareWeb(e, userId, await requireOwned(e, userId, bookId));
		await asResearched(e, userId, bookId);

		mockTavily([], 2); // basic 빈손 → advanced 도 빈손
		const out = await prepareWeb(e, userId, await requireOwned(e, userId, bookId));

		expect(out).toHaveLength(before.length);
		expect(cachedWeb(await requireOwned(e, userId, bookId)).length).toBe(before.length);
	});
});

describe("참고 자료 적재", () => {
	/** 실제 검색 결과의 절반 이상이 이렇게 생겼다 — 제목은 맞지만 책 내용이 없다. */
	const SHOP_PAGES = Array.from({ length: 5 }, (_, i) => ({
		url: `https://shop.example.com/p/${i}`,
		title: "움푹산의 비밀 - 인터넷 서점",
		content: "움푹산의 비밀 정가 13,000원 판매가 11,700원 10% 적립 배송 무료 장바구니 담기 바로구매",
		raw_content: "재고 있음 오늘 출발 판매지수 1,240 회원리뷰 12건 쿠폰 받기",
		score: 0.95 - i * 0.01,
	}));

	/**
	 * 조사 결과를 책에 반영한다. 참고 자료가 쌓이는 곳은 여기 하나다.
	 *
	 * 서지 결과를 미리 적어 둔다. 비워 두면 반영 단계가 공개 API 를 실제로 부른다 —
	 * 여기서 재려는 것은 그 조회가 아니라 **웹 자료를 목록에 어떻게 올리는가**다.
	 */
	async function applyFound(e: AppEnv, userId: string, bookId: string, bib: unknown[] = []) {
		await booksRepo.update(e, userId, bookId, {
			bib_cache: JSON.stringify(
				bib.length > 0
					? bib
					: [
							{
								source: "kakao-book",
								title: "움푹산의 비밀",
								author: "천희순",
								publisher: "크레용하우스",
								isbn13: "",
								publishedAt: "",
								description: "거인 크네가 사는 움푹산 이야기입니다.",
								url: "https://kakao.example/1",
							},
						],
			),
		});

		return applyResearch(
			e,
			userId,
			bookId,
			{
				found: true,
				title: "움푹산의 비밀",
				author: "천희순",
				publisher: "크레용하우스",
				isbn13: "",
				publishedAt: "",
				targetAge: "",
				bookLanguage: "ko",
				arLevel: "",
				arPoints: "",
				arInterestLevel: "",
				lexile: "",
				description: "",
				plotSummary: "거인 크네가 움푹산의 아이들을 구해 낸다.",
				characters: [{ name: "크네", role: "거인" }],
				keyEvents: ["크네가 아이들을 구한다"],
				sources: [],
			},
			{ groundingUsed: true, searchNotice: null, modelNotice: null, model: "test-model" },
		);
	}

	it("줄거리 없는 페이지는 목록에 올리지 않는다", async () => {
		const { bookId, userId } = await aBook();
		const e = withKeys("tvly-test");

		mockTavily([...SHOP_PAGES, ...PAGES], 1);
		await prepareWeb(e, userId, await requireOwned(e, userId, bookId));
		await applyFound(e, userId, bookId);

		// 13건을 받았지만 목록에 남는 웹 자료는 줄거리를 다룬 8건이다.
		const rows = await booksRepo.listSources(e, bookId);
		const web = rows.filter((row) => row.source === "web");
		expect(web).toHaveLength(PAGES.length);
		expect(web.every((row) => row.url!.startsWith("https://blog.example.com/"))).toBe(true);

		// 프롬프트에 실을 자료는 줄이지 않는다. 거르는 것은 부모가 눈으로 읽는 목록뿐이다.
		expect(cachedWeb(await requireOwned(e, userId, bookId))).toHaveLength(
			SHOP_PAGES.length + PAGES.length,
		);
	});

	it("판매 페이지만 걸리면 웹 자료를 올리지 않는다", async () => {
		const { bookId, userId } = await aBook();
		const e = withKeys("tvly-test");

		// 제목은 다 맞으므로 한 번으로 끝난다 — 넓혀 다시 찾는 것은 "이 책" 을 못 찾았을 때다.
		mockTavily(SHOP_PAGES, 1);
		await prepareWeb(e, userId, await requireOwned(e, userId, bookId));
		await applyFound(e, userId, bookId);

		const rows = await booksRepo.listSources(e, bookId);
		expect(rows.filter((row) => row.source === "web")).toHaveLength(0);
	});

	/**
	 * 부모가 근거를 훑는 순서 — 카카오 책 → 알라딘 → 웹 검색.
	 *
	 * `created_at` 으로는 지킬 수 없다. 한 배치로 넣으면 밀리초까지 같은 값이 박혀 정렬이
	 * 사실상 무순서가 된다. `position` 이 그 자리를 맡는다.
	 */
	it("카카오 책 → 알라딘 → 웹 검색 순으로 늘어놓는다", async () => {
		const { bookId, userId } = await aBook();
		const e = withKeys("tvly-test");

		mockTavily(PAGES, 1);
		await prepareWeb(e, userId, await requireOwned(e, userId, bookId));

		// 일부러 알라딘을 앞에 적어 둔다. 순서를 정하는 것은 적힌 순서가 아니라 소스 종류다.
		await applyFound(e, userId, bookId, [
			{
				source: "aladin",
				title: "움푹산의 비밀",
				author: "천희순",
				publisher: "크레용하우스",
				isbn13: "",
				publishedAt: "",
				description: "알라딘 책소개입니다.",
				url: "https://aladin.example/1",
			},
			{
				source: "kakao-book",
				title: "움푹산의 비밀",
				author: "천희순",
				publisher: "크레용하우스",
				isbn13: "",
				publishedAt: "",
				description: "카카오 책소개입니다.",
				url: "https://kakao.example/1",
			},
		]);

		const kinds = (await booksRepo.listSources(e, bookId)).map((row) => row.source);
		expect(kinds[0]).toBe("kakao-book");
		expect(kinds[1]).toBe("aladin");
		expect(kinds.slice(2).every((kind) => kind === "web")).toBe(true);
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

/**
 * 질의 사다리 (§docs/tavily-search-plan.md).
 *
 * 여기서 지키려는 것은 하나다 — **다시 찾기를 누르면 다른 질의가 나가는 것.** 예전에는
 * 같은 질의가 그대로 다시 나가서, 책당 6회의 재검색이 같은 결과를 여섯 번 받아 오는
 * 일이었다. 크레딧을 쓰고 근거는 늘지 않는다.
 */
describe("질의 사다리", () => {
	const KO = { title: "움푹산의 비밀", author: "천희순", publisher: "크레용하우스" };
	const EN = { title: "Dirty Bertie PONG!", author: "Alan MacDonald", publisher: "Stripes" };

	it("시도가 늘면 좁은 질의도 넓은 질의도 바뀐다", () => {
		const narrow = [0, 1, 2].map((n) => buildQuery(KO, false, n).query);
		const broad = [0, 1, 2].map((n) => buildQuery(KO, true, n).query);

		expect(new Set(narrow).size).toBe(3);
		expect(new Set(broad).size).toBe(3);
	});

	/**
	 * 좁은 것과 넓은 것의 길이가 서로 나누어지지 않아야(4·3) 여섯 번을 다른 조합으로 쓴다.
	 * 상한(`MAX_SEARCHES_PER_BOOK`)만큼 눌러도 같은 짝이 다시 나오지 않아야 한다.
	 */
	it("책당 상한까지 짝이 겹치지 않는다", () => {
		const pairs = Array.from({ length: budget.MAX_SEARCHES_PER_BOOK }, (_, n) =>
			`${buildQuery(KO, false, n).query} || ${buildQuery(KO, true, n).query}`,
		);
		expect(new Set(pairs).size).toBe(budget.MAX_SEARCHES_PER_BOOK);
	});

	it("첫 시도의 질의는 예전과 같다", () => {
		// 여기까지 재어 둔 실측(Phase 0)이 이 질의로 나온 것이다. 기준선을 옮기지 않는다.
		expect(buildQuery(KO, false, 0).query).toBe('"움푹산의 비밀" 천희순 줄거리 등장인물 독후감');
		expect(buildQuery(KO, true, 0).query).toBe("움푹산의 비밀 천희순 어린이책 내용");
	});

	// 영어책에 한국어 낱말을 붙이면 엉뚱한 한국 사이트가 20건 중 8건을 차지했다(Phase 0).
	it("영어책에는 영어 낱말만 붙고 국가를 묶지 않는다", () => {
		for (let n = 0; n < 6; n++) {
			for (const broad of [false, true]) {
				const { query, country } = buildQuery(EN, broad, n);
				expect(query).not.toMatch(/[가-힣]/);
				expect(country).toBeUndefined();
			}
		}
	});

	it("한국책에는 국가를 묶는다", () => {
		expect(buildQuery(KO, false, 3).country).toBe("south korea");
	});

	// 출판사를 못 읽은 책이 있다. 빈 값이 질의에 두 칸 공백으로 남으면 안 된다.
	it("출판사가 없어도 질의에 빈 칸이 겹치지 않는다", () => {
		for (let n = 0; n < 6; n++) {
			for (const broad of [false, true]) {
				const { query } = buildQuery({ title: "제목", author: "" }, broad, n);
				expect(query).not.toMatch(/\s{2}/);
				expect(query.trim()).toBe(query);
			}
		}
	});

	// 상한을 넘겨 들어와도 터지지 않아야 한다. 옛 행의 카운터가 어긋날 수 있다.
	it("시도가 사다리보다 커도 감아서 고른다", () => {
		expect(buildQuery(KO, false, 99).query).toBeTruthy();
		expect(buildQuery(KO, false, -1).query).toBe(buildQuery(KO, false, 0).query);
	});
});
