import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { normalizeResearch, type BookResearch } from "../src/search/web";
import { applyResearch } from "../src/services/book";
import { MAX_PLOT, mergeCharacters, mergeEvents, mergePlot } from "../src/services/plot";
import { type Client, signupParent } from "./helpers";

/**
 * "정보 다시 찾기" 는 줄거리를 **쌓는 일**이다.
 *
 * 예전에는 그 일을 조사 프롬프트에게 부탁했다 — `[지금까지 정리한 줄거리]` 를 되돌려 주며
 * "지우지 말고 보강하세요" 라고 시켰다. 모델은 그 말을 자주 흘렸고, 다시 찾을 때마다 줄거리가
 * 통째로 새 것으로 갈렸다. 이번 자료가 지난 자료보다 얇으면 줄거리는 오히려 짧아졌다.
 *
 * 그래서 서버가 문장 단위로 합친다. 여기서 재는 것은 그 합치기다.
 */

const FIRST = [
	"움푹산에는 거인 크네가 혼자 살고 있다.",
	"마을 사람들은 크네가 덩치가 크다는 이유만으로 무서워하며 가까이 가지 않았다.",
].join(" ");

describe("줄거리 쌓기", () => {
	// 처음 찾은 책은 이 합치기가 있기 전과 **똑같아야** 한다. 쌓을 것이 없는데 글이 바뀌면 안 된다.
	it("쌓아 둔 것이 없으면 이번 조사 결과를 손대지 않는다", () => {
		expect(mergePlot("", FIRST)).toBe(FIRST);
	});

	// 이것이 이번 결함이다. 모델이 지난 내용을 버리고 새 문장만 보내도 지난 것은 남아야 한다.
	it("이번 조사가 지난 내용을 버려도 지난 줄거리는 남는다", () => {
		const merged = mergePlot(FIRST, "어느 날 마을 아이들이 움푹산에서 길을 잃었다.");

		expect(merged).toContain("거인 크네가 혼자 살고 있다");
		expect(merged).toContain("마을 아이들이 움푹산에서 길을 잃었다");
	});

	it("새로 확인된 사건이 뒤에 붙는다 — 순서가 뒤집히지 않는다", () => {
		const merged = mergePlot(FIRST, "크네가 산속으로 들어가 아이들을 하나씩 찾아 데려다주었다.");

		expect(merged.indexOf("거인 크네가 혼자")).toBeLessThan(merged.indexOf("하나씩 찾아"));
	});

	// 모델은 지난 줄거리를 제 말로 다시 쓴 뒤 새 사건을 붙이는 일이 많다. 그것을 그대로 받으면
	// 같은 이야기가 두 번 적히고, 그 Brief 가 라운드마다 프롬프트에 실린다.
	it("같은 문장을 다시 보내면 두 번 적지 않는다", () => {
		const merged = mergePlot(FIRST, FIRST);
		expect(merged).toBe(mergePlot("", FIRST));
	});

	it("지난 문장을 조금 고쳐 보낸 것도 되풀이로 본다", () => {
		const merged = mergePlot(FIRST, "움푹산에는 거인 크네가 혼자 살고 있었다.");
		const count = merged.split("거인 크네가 혼자").length - 1;
		expect(count).toBe(1);
	});

	/**
	 * 여기가 낱말 비교로는 안 되는 자리다.
	 *
	 * 줄거리는 같은 인물·장소 이름을 계속 되풀이한다. 낱말이 겹치는 것을 "이미 담긴 문장" 으로
	 * 보면 정작 새로 찾은 사건이 버려진다 — 쌓으려고 만든 장치가 반대로 깎아낸다.
	 */
	it("같은 인물이 나오는 새 사건은 버리지 않는다", () => {
		const merged = mergePlot(
			"마을 사람들은 크네를 무서워하며 가까이 가지 않았다.",
			"마을 사람들은 크네에게 사과하고 이웃으로 받아들였다.",
		);

		expect(merged).toContain("가까이 가지 않았다");
		expect(merged).toContain("이웃으로 받아들였다");
	});

	it("빈손으로 돌아온 조사는 쌓아 둔 것을 건드리지 않는다", () => {
		expect(mergePlot(FIRST, "")).toBe(mergePlot("", FIRST));
	});

	/**
	 * Brief 는 문제 생성 라운드마다 프롬프트에 그대로 실린다. 한없이 부풀면 매 라운드 비용이
	 * 늘고 모델이 중간을 흘린다.
	 */
	it("상한에 닿으면 더 붙이지 않고, 쌓아 둔 것을 잘라내지도 않는다", () => {
		// 서로 겹치지 않는 문장. 글자를 흩어 놓아 되풀이로 걸리지 않게 한다.
		const sentence = (i: number) =>
			`${Array.from({ length: 40 }, (_, j) => String.fromCharCode(0xac00 + ((i * 977 + j * 31) % 11172))).join("")}.`;

		// 상한을 넘도록 여러 번 다시 찾는다.
		let pooled = mergePlot("", sentence(0));
		for (let round = 1; round < 300; round++) pooled = mergePlot(pooled, sentence(round));

		// 마지막 한 문장까지는 넘어갈 수 있다. 쌓아 둔 것을 잘라내지 않는 편을 택했다.
		expect(pooled.length).toBeGreaterThan(MAX_PLOT - 100);
		expect(pooled.length).toBeLessThanOrEqual(MAX_PLOT + 50);
		expect(mergePlot(pooled, "마지막에 크네가 마을로 내려왔다.")).toBe(pooled);
	});
});

describe("등장인물 쌓기", () => {
	it("지난 인물을 지우지 않고 새 인물을 더한다", () => {
		const merged = mergeCharacters([{ name: "크네", role: "거인" }], [{ name: "마을 아이들", role: "길을 잃는다" }]);

		expect(merged.map((person) => person.name)).toEqual(["크네", "마을 아이들"]);
	});

	// 이름은 조사마다 그대로 오지만 역할 설명은 자세함이 갈린다.
	it("같은 인물이면 더 자세히 적힌 역할을 남긴다", () => {
		const merged = mergeCharacters(
			[{ name: "크네", role: "거인" }],
			[{ name: "크네", role: "움푹산에 혼자 사는 거인" }],
		);

		expect(merged).toHaveLength(1);
		expect(merged[0]!.role).toBe("움푹산에 혼자 사는 거인");
	});

	it("이번 조사가 짧게 적어 보내도 쌓아 둔 설명을 잃지 않는다", () => {
		const merged = mergeCharacters([{ name: "크네", role: "움푹산에 혼자 사는 거인" }], [{ name: "크네", role: "거인" }]);

		expect(merged[0]!.role).toBe("움푹산에 혼자 사는 거인");
	});

	it("이름이 빈 항목은 버린다", () => {
		expect(mergeCharacters([], [{ name: "  ", role: "거인" }])).toEqual([]);
	});
});

describe("주요 사건 쌓기", () => {
	/**
	 * 줄거리와 반대로 **이번 조사가 순서를 정한다.** 이 목록의 이름이 "일어난 순서" 이고
	 * 그 순서로 순서 문항이 나오기 때문이다.
	 */
	it("이번 조사가 늘어놓은 순서를 그대로 받는다", () => {
		const merged = mergeEvents(["아이들이 길을 잃는다"], ["크네가 산에 혼자 산다", "아이들이 길을 잃는다"]);

		expect(merged).toEqual(["크네가 산에 혼자 산다", "아이들이 길을 잃는다"]);
	});

	it("이번 조사가 흘린 지난 사건은 뒤에 붙여 지킨다", () => {
		const merged = mergeEvents(["크네가 산에 혼자 산다"], ["마을 사람들이 크네를 이웃으로 받아들인다"]);

		expect(merged).toEqual(["마을 사람들이 크네를 이웃으로 받아들인다", "크네가 산에 혼자 산다"]);
	});

	it("빈손으로 돌아온 조사는 쌓아 둔 사건을 건드리지 않는다", () => {
		expect(mergeEvents(["크네가 산에 혼자 산다"], [])).toEqual(["크네가 산에 혼자 산다"]);
	});

	it("같은 사건을 말만 바꿔 보내면 두 번 담지 않는다", () => {
		const merged = mergeEvents(["크네가 아이들을 하나씩 찾아 데려다준다"], ["크네가 아이들을 하나씩 찾아 데려다주었다"]);

		expect(merged).toHaveLength(1);
	});
});

const PNG_BYTES = new Uint8Array([
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

/** 이번 조사가 돌려준 결과. 넘기지 않은 항목은 비어 있다 — 모델이 흘린 경우다. */
const research = (
	plot: string,
	over: Partial<Pick<BookResearch, "characters" | "keyEvents" | "sources">> = {},
): BookResearch => ({
	found: true,
	title: "움푹산의 비밀",
	author: "천희순",
	publisher: "크레용하우스",
	isbn13: "9788955472905",
	publishedAt: "2013-04-24",
	targetAge: "초등 3~4학년",
	bookLanguage: "ko",
	arLevel: "",
	arPoints: "",
	arInterestLevel: "",
	lexile: "",
	description: "다릿돌읽기 시리즈.",
	plotSummary: plot,
	characters: [],
	keyEvents: [],
	sources: [],
	...over,
});

const NOTICES = {
	groundingUsed: true,
	searchNotice: null,
	modelNotice: null,
	model: "gemini-3.6-flash",
};

/** 표지만 올리고 제목을 직접 넣는다. AI 는 한 번도 부르지 않는다. */
async function bookWithTitle(): Promise<{ client: Client; userId: string; bookId: string }> {
	const { client } = await signupParent();
	const form = new FormData();
	form.append("cover", new File([PNG_BYTES], "cover.png", { type: "image/png" }));
	const created = await client.upload("/api/books", form);
	const bookId = created.body.data.book.id;

	await client.request(`/api/books/${bookId}`, {
		method: "PATCH",
		body: { title: "움푹산의 비밀", author: "천희순", publisher: "크레용하우스" },
	});

	// 조사 준비 단계가 적어 두는 서지 캐시. 없으면 반영이 서지 API 를 새로 부른다.
	await env.DB.prepare("UPDATE books SET bib_cache = ? WHERE id = ?")
		.bind(
			JSON.stringify([
				{
					source: "aladin",
					title: "움푹산의 비밀",
					author: "천희순",
					publisher: "크레용하우스",
					publishedAt: "2013-04-24",
					isbn13: "9788955472905",
					url: "https://example.com/book",
					description: "거인 크네가 움푹산의 아이들을 구해 낸 이야기.",
				},
			]),
			bookId,
		)
		.run();

	const owner = await env.DB.prepare("SELECT created_by FROM books WHERE id = ?")
		.bind(bookId)
		.first<{ created_by: string }>();

	return { client, userId: owner!.created_by, bookId };
}

/**
 * 부모가 "정보 다시 찾기" 를 눌렀을 때.
 *
 * 어느 경로로 들어오든 조사 결과를 책에 쓰는 곳은 `applyResearch` 하나뿐이라 그것을 직접
 * 부른다(릴레이 경로는 gemini 키를 요구한다).
 */
describe("정보 다시 찾기", () => {
	it("두 번째 조사가 지난 줄거리를 갈아 끼우지 않고 더한다", async () => {
		const { userId, bookId } = await bookWithTitle();

		await applyResearch(
			env,
			userId,
			bookId,
			normalizeResearch(research("움푹산에는 거인 크네가 혼자 살고 있다.")),
			NOTICES,
		);
		// 두 번째 조사는 지난 내용을 잊고 새 사건만 말한다 — 실제로 자주 이렇게 온다.
		await applyResearch(
			env,
			userId,
			bookId,
			normalizeResearch(research("마을 아이들이 길을 잃자 크네가 산속에서 하나씩 찾아 데려다주었다.")),
			NOTICES,
		);

		const row = await env.DB.prepare("SELECT ai_plot, brief FROM books WHERE id = ?")
			.bind(bookId)
			.first<{ ai_plot: string; brief: string }>();

		expect(row!.ai_plot).toContain("거인 크네가 혼자 살고 있다");
		expect(row!.ai_plot).toContain("하나씩 찾아 데려다주었다");
		// Brief 에 실려야 출제 근거가 된다. 여기 안 들어가면 근거 검사가 전부 탈락시킨다.
		expect(row!.brief).toContain("거인 크네가 혼자 살고 있다");
		expect(row!.brief).toContain("하나씩 찾아 데려다주었다");
	});

	it("두 번째 조사가 지난 등장인물과 사건을 지우지 않는다", async () => {
		const { userId, bookId } = await bookWithTitle();

		await applyResearch(
			env,
			userId,
			bookId,
			normalizeResearch(
				research("움푹산에는 거인 크네가 혼자 살고 있다.", {
					characters: [{ name: "크네", role: "거인" }],
					keyEvents: ["크네가 움푹산에 혼자 산다"],
				}),
			),
			NOTICES,
		);
		// 두 번째 조사는 크네를 잊고 새 인물·사건만 말한다.
		await applyResearch(
			env,
			userId,
			bookId,
			normalizeResearch(
				research("마을 아이들이 움푹산에서 길을 잃었다.", {
					characters: [{ name: "마을 아이들", role: "움푹산에서 길을 잃는다" }],
					keyEvents: ["아이들이 움푹산에서 길을 잃는다"],
				}),
			),
			NOTICES,
		);

		const row = await env.DB.prepare("SELECT ai_characters, ai_events, brief FROM books WHERE id = ?")
			.bind(bookId)
			.first<{ ai_characters: string; ai_events: string; brief: string }>();

		expect(JSON.parse(row!.ai_characters).map((p: { name: string }) => p.name)).toEqual(["크네", "마을 아이들"]);
		expect(JSON.parse(row!.ai_events)).toHaveLength(2);
		// Brief 에 실려야 출제 근거가 된다.
		expect(row!.brief).toContain("- 크네: 거인");
		expect(row!.brief).toContain("- 마을 아이들:");
		expect(row!.brief).toContain("크네가 움푹산에 혼자 산다");
	});

	/**
	 * 부모가 실제로 겪은 자리다 — 다시 찾을 때마다 참고 자료 목록이 새로 쓰였다.
	 *
	 * 모델이 적어 준 출처는 이번 조사 것만 남았고, 웹 자료 묶음은 상한에 밀려 사라졌다.
	 * 부모가 지난번에 열어 본 자료가 없어지면 검수를 이어 갈 수 없다.
	 */
	it("지난 조사에서 올린 참고 자료가 목록에 남는다", async () => {
		// 자료의 제목이 이 책을 가리켜야 다음 조사에서도 들고 온다 — 제목을 고쳐 다른 책이 된
		// 자료는 남기지 않는다(`books.test.ts` 의 "이전 출처가 남지 않는다").
		const { userId, bookId } = await bookWithTitle();

		await applyResearch(
			env,
			userId,
			bookId,
			normalizeResearch(
				research("움푹산에는 거인 크네가 혼자 살고 있다.", {
					sources: [{ url: "https://example.com/first", title: "움푹산의 비밀 독후감" }],
				}),
			),
			NOTICES,
		);
		await applyResearch(
			env,
			userId,
			bookId,
			normalizeResearch(
				research("마을 아이들이 움푹산에서 길을 잃었다.", {
					sources: [{ url: "https://example.com/second", title: "움푹산의 비밀 서평" }],
				}),
			),
			NOTICES,
		);

		const { results } = await env.DB.prepare(
			"SELECT url FROM book_sources WHERE book_id = ? ORDER BY position",
		)
			.bind(bookId)
			.all<{ url: string }>();

		expect(results.map((row) => row.url)).toEqual([
			"https://example.com/first",
			"https://example.com/second",
		]);
	});

	// 부모가 보태려고 적은 글이 오히려 AI 가 찾아 둔 줄거리를 깎아내면 안 된다.
	it("부모가 줄거리를 적어도 쌓아 둔 줄거리는 남는다", async () => {
		const { client } = await signupParent();
		const form = new FormData();
		form.append("cover", new File([PNG_BYTES], "cover.png", { type: "image/png" }));
		const created = await client.upload("/api/books", form);
		const bookId = created.body.data.book.id;
		await client.request(`/api/books/${bookId}`, { method: "PATCH", body: { title: "움푹산의 비밀" } });

		await env.DB.prepare("UPDATE books SET ai_plot = ? WHERE id = ?")
			.bind("움푹산에는 거인 크네가 혼자 살고 있다.", bookId)
			.run();

		await client.request(`/api/books/${bookId}/plot`, {
			method: "PUT",
			body: {
				plot: "마을 아이들이 움푹산에서 길을 잃자 크네가 산속으로 들어가 아이들을 하나씩 찾아 마을까지 데려다주었다.",
			},
		});

		const row = await env.DB.prepare("SELECT brief FROM books WHERE id = ?")
			.bind(bookId)
			.first<{ brief: string }>();

		expect(row!.brief).toContain("거인 크네가 혼자 살고 있다");
		expect(row!.brief).toContain("하나씩 찾아 마을까지 데려다주었다");
	});
});
