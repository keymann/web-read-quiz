import { describe, expect, it } from "vitest";
import { buildResearchRequest, normalizeResearch, type BookResearch } from "../src/search/web";
import { applyResearch } from "../src/services/book";
import type { BibRecord } from "../src/search/bibliographic";

/**
 * AI 가 모르는 책을 만났을 때 무슨 일이 벌어져야 하는가.
 *
 * 실측 『움푹산의 비밀』(천희순, 크레용하우스): 서지 조회로 제목·지은이·출판사·책소개까지
 * 확인됐는데도 조사 모델이 모든 항목을 비워 돌려줬다. 그때 화면은 참고 자료 2건을 보여주며
 * "근거 자료가 충분합니다" 라고 하고, 바로 아래에서 "먼저 책 정보를 찾아 주세요" 라고 했다.
 */

const record = (over: Partial<BibRecord> = {}): BibRecord => ({
	source: "aladin",
	title: "움푹산의 비밀",
	author: "천희순",
	publisher: "크레용하우스",
	publishedAt: "2013-04-24",
	isbn13: "9788955472905",
	url: "https://example.com/book",
	description:
		"다릿돌읽기 시리즈. 거인이기 때문에 사람들에게 냉대를 받던 크네가 움푹산의 아이들을 구해 낸 이야기를 담고 있다.",
	...over,
});

const hint = (bib: BibRecord[]) => ({
	title: "움푹산의 비밀",
	author: "천희순",
	publisher: "크레용하우스",
	isbn: "9788955472905",
	bib,
});

const textOf = (request: ReturnType<typeof buildResearchRequest>) =>
	`${request.instructions}\n${request.prompt}`;

describe("조사 프롬프트에 실리는 서지 정보", () => {
	/**
	 * 이것이 이번 결함의 원인이다.
	 *
	 * 책소개를 받아서 HTML 을 벗기고 캐시까지 해 두고는 조사 모델에게만 안 보여 줬다.
	 * 그 결과 모델이 갈렸다 — 하나는 빈손, 하나는 **다른 책 이야기를 통째로 지어냈다**
	 * (거인 크네 이야기를 소년과 한국 표범 이야기로).
	 */
	it("확인된 책소개를 모델에게 보여준다", () => {
		const text = textOf(buildResearchRequest("gemini-3.6-flash", hint([record()]), false));
		expect(text).toContain("거인이기 때문에 사람들에게 냉대를 받던 크네");
	});

	// Brief 자체가 날조되면 근거 검사는 그 날조를 "근거 있음" 으로 인정한다.
	// 대조할 사실을 주는 것이 유일한 방어다.
	it("기억이 책소개와 어긋나면 비우라고 지시한다", () => {
		const text = textOf(buildResearchRequest("gemini-3.6-flash", hint([record()]), false));
		expect(text).toContain("어긋나면");
		expect(text).toMatch(/모든 항목을 비워/);
	});

	// 책소개는 홍보 문구다. 그것으로 줄거리를 채우면 책을 읽지 않아도 답할 수 있다(§7).
	it("책소개를 줄거리로 옮겨 쓰지 말라고 지시한다", () => {
		const text = textOf(buildResearchRequest("gemini-3.6-flash", hint([record()]), false));
		expect(text).toContain("plotSummary 를 채우지 마세요");
	});

	it("검색을 쓰는 경우에도 같은 대조 규칙이 붙는다", () => {
		const text = textOf(buildResearchRequest("gemini-3.6-flash", hint([record()]), true));
		expect(text).toContain("거인이기 때문에 사람들에게 냉대를 받던 크네");
		expect(text).toContain("어긋나면");
	});

	// 없는 것을 대조하라고 하면 혼란만 준다.
	it("서지 정보가 없으면 대조 규칙을 붙이지 않는다", () => {
		const text = textOf(buildResearchRequest("gemini-3.6-flash", hint([]), false));
		expect(text).not.toContain("어긋나면");
	});

	it("책소개가 비어 있으면 그 줄만 빠진다", () => {
		const text = textOf(buildResearchRequest("gemini-3.6-flash", hint([record({ description: "" })]), false));
		expect(text).toContain("움푹산의 비밀 / 천희순");
		expect(text).not.toContain("책소개:");
	});
});

/* ── 부모가 직접 적은 줄거리 ─────────────────────────── */

import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll } from "vitest";
import { Client, signupParent } from "./helpers";

const PNG_BYTES = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

const PLOT = [
	"움푹산에는 거인 크네가 혼자 살고 있다. 마을 사람들은 크네가 덩치가 크고 생김새가 다르다는",
	"이유만으로 무서워하며 가까이 가지 않았다. 어느 날 마을 아이들이 움푹산에서 길을 잃자",
	"크네가 산속으로 들어가 아이들을 하나씩 찾아 마을까지 데려다주었다. 그 뒤로 마을 사람들은",
	"겉모습만 보고 크네를 멀리했던 것을 부끄러워하며 크네를 이웃으로 받아들였다.",
].join(" ");

/** 모델이 이 책을 모를 때 돌려주는 모양 — 모든 항목이 비어 있다. */
const EMPTY_RESEARCH: BookResearch = {
	found: false,
	title: "",
	author: "",
	publisher: "",
	isbn13: "",
	publishedAt: "",
	targetAge: "",
	bookLanguage: "",
	arLevel: "",
	arPoints: "",
	arInterestLevel: "",
	lexile: "",
	description: "",
	plotSummary: "",
	characters: [],
	keyEvents: [],
	sources: [],
};

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

/** 표지만 올리고 제목을 직접 넣는다. AI 는 한 번도 부르지 않는다. */
async function bookWithTitle(): Promise<{ client: Client; bookId: string }> {
	const { client } = await signupParent();
	const form = new FormData();
	form.append("cover", new File([PNG_BYTES], "cover.png", { type: "image/png" }));
	const created = await client.upload("/api/books", form);
	const bookId = created.body.data.book.id;

	await client.request(`/api/books/${bookId}`, {
		method: "PATCH",
		body: { title: "움푹산의 비밀", author: "천희순", publisher: "크레용하우스" },
	});
	return { client, bookId };
}

describe("부모가 직접 적은 줄거리", () => {
	it("적으면 문제 만들기가 열린다", async () => {
		const { client, bookId } = await bookWithTitle();

		const before = await client.request(`/api/books/${bookId}`);
		expect(before.body.data.readyForQuiz).toBe(false);

		const saved = await client.request(`/api/books/${bookId}/plot`, { method: "PUT", body: { plot: PLOT } });
		expect(saved.status).toBe(200);
		expect(saved.body.data.readyForQuiz).toBe(true);

		// 화면을 다시 열어도 같아야 한다. 예전에 이 둘이 갈려서 버튼이 잠기는 일이 있었다.
		const after = await client.request(`/api/books/${bookId}`);
		expect(after.body.data.readyForQuiz).toBe(true);
		expect(after.body.data.book.manualPlot).toContain("거인 크네");
	});

	// 적은 내용이 그대로 출제 근거가 된다. Brief 에 안 실리면 근거 검사가 전부 탈락시킨다.
	it("적은 내용이 Brief 의 줄거리로 들어간다", async () => {
		const { client, bookId } = await bookWithTitle();
		await client.request(`/api/books/${bookId}/plot`, { method: "PUT", body: { plot: PLOT } });

		const row = await env.DB.prepare("SELECT brief FROM books WHERE id = ?")
			.bind(bookId)
			.first<{ brief: string }>();

		expect(row!.brief).toContain("[줄거리]");
		expect(row!.brief).toContain("아이들을 하나씩 찾아");
	});

	it("문제를 만들 만큼 되지 않는 길이는 거절한다", async () => {
		const { client, bookId } = await bookWithTitle();
		const res = await client.request(`/api/books/${bookId}/plot`, { method: "PUT", body: { plot: "재미있는 이야기" } });

		expect(res.status).toBe(400);
		expect(await client.request(`/api/books/${bookId}`).then((r) => r.body.data.readyForQuiz)).toBe(false);
	});

	it("비우면 문제 만들기가 다시 잠긴다", async () => {
		const { client, bookId } = await bookWithTitle();
		await client.request(`/api/books/${bookId}/plot`, { method: "PUT", body: { plot: PLOT } });

		const cleared = await client.request(`/api/books/${bookId}/plot`, { method: "PUT", body: { plot: "" } });
		expect(cleared.body.data.readyForQuiz).toBe(false);
	});

	it("남의 책에는 쓸 수 없다", async () => {
		const { bookId } = await bookWithTitle();
		const { client: other } = await signupParent();

		const res = await other.request(`/api/books/${bookId}/plot`, { method: "PUT", body: { plot: PLOT } });
		expect(res.status).toBe(404);
	});
});

describe("조사가 빈손으로 돌아왔을 때", () => {
	/**
	 * 예전에는 `found=false` 면 brief 를 통째로 null 로 덮었다. 그래서 잘 되던 책도
	 * "정보 다시 찾기" 한 번에 줄거리를 잃고 문제 만들기 버튼이 잠겼다. 모델이 한 번 빈손으로
	 * 돌아오는 것은 흔한 일이라(무료 등급·과부하·잘 안 알려진 책) 실제로 겪게 된다.
	 */
	it("이미 저장돼 있던 줄거리를 지우지 않는다", async () => {
		const { client, bookId } = await bookWithTitle();
		await client.request(`/api/books/${bookId}/plot`, { method: "PUT", body: { plot: PLOT } });

		// 조사 준비 단계가 적어 두는 서지 캐시. 없으면 반영이 서지 API 를 새로 부른다.
		await env.DB.prepare("UPDATE books SET bib_cache = ? WHERE id = ?")
			.bind(JSON.stringify([{ ...record(), source: "aladin" }]), bookId)
			.run();

		// 릴레이 경로는 gemini 키를 요구하므로 반영 규칙을 직접 부른다. 어느 경로로 들어오든
		// 조사 결과를 책에 쓰는 곳은 `applyResearch` 하나뿐이다.
		const owner = await env.DB.prepare("SELECT created_by FROM books WHERE id = ?")
			.bind(bookId)
			.first<{ created_by: string }>();

		const result = await applyResearch(env, owner!.created_by, bookId, normalizeResearch(EMPTY_RESEARCH), {
			groundingUsed: false,
			searchNotice: null,
			modelNotice: null,
			model: "gemini-3.6-flash",
		});

		expect(result.research.found).toBe(false);
		// 여기가 핵심 — 조사가 실패해도 부모의 줄거리는 남는다.
		expect(result.readyForQuiz).toBe(true);

		const after = await client.request(`/api/books/${bookId}`);
		expect(after.body.data.readyForQuiz).toBe(true);
		expect(after.body.data.book.manualPlot).toContain("거인 크네");
	});
});
