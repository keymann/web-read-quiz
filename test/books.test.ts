import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client, addChild, signupParent } from "./helpers";

const API_KEY = "sk-test1234567890abcdefghijklmn";

/** 최소한의 유효한 PNG 1x1. 매직 바이트 검증을 통과한다. */
const PNG_BYTES = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

const IDENTITY = {
	title: "마당을 나온 암탉",
	author: "황선미",
	publisher: "사계절",
	isbn: "9788958281252",
	series: "",
	confidence: 0.93,
};

const RESEARCH = {
	found: true,
	title: "마당을 나온 암탉",
	author: "황선미",
	publisher: "사계절",
	isbn13: "9788958281252",
	publishedAt: "2000-05-15",
	targetAge: "초등 고학년",
	description: "양계장을 나온 암탉 잎싹의 이야기.",
	plotSummary: "잎싹은 알을 품고 싶어 양계장을 떠난다. 청둥오리의 알을 품어 초록이를 기른다.",
	characters: [
		{ name: "잎싹", role: "알을 품고 싶어 하는 암탉" },
		{ name: "초록이", role: "잎싹이 기른 청둥오리" },
	],
	keyEvents: ["잎싹이 양계장을 떠난다", "잎싹이 알을 품는다", "초록이가 무리를 따라 떠난다"],
	sources: [
		{ url: "https://example.com/a", title: "출판사 소개", content: "잎싹의 이야기" },
		{ url: "https://example.com/b", title: "서평", content: "성장 서사" },
	],
};

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

function mockModels(times = 1) {
	fetchMock
		.get("https://api.openai.com")
		.intercept({ path: "/v1/models", method: "GET" })
		.reply(200, { data: [{ id: "gpt-5.6-mini" }] })
		.times(times);
}

/** Responses API 는 output 배열 안의 output_text 로 결과를 준다. */
function mockResponses(payload: unknown, times = 1) {
	fetchMock
		.get("https://api.openai.com")
		.intercept({ path: "/v1/responses", method: "POST" })
		.reply(200, {
			status: "completed",
			output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(payload) }] }],
		})
		.times(times);
}

/** 공개 서지 API 는 붙지 않는 게 기본. 필요할 때만 인터셉터를 건다. */
function mockGoogleBooksMiss() {
	fetchMock
		.get("https://www.googleapis.com")
		.intercept({ path: (p) => p.startsWith("/books/v1/volumes"), method: "GET" })
		.reply(200, {});
}

function mockOpenLibraryMiss() {
	fetchMock
		.get("https://openlibrary.org")
		.intercept({ path: (p) => p.startsWith("/api/books"), method: "GET" })
		.reply(200, {});
}

async function withKey(): Promise<Client> {
	const { client } = await signupParent();
	// 키 저장은 모델 목록 조회 + 추론 가능 확인, 두 번을 부른다.
	mockModels(1);
	mockResponses({ ok: true });
	await client.request("/api/settings/openai-key", { method: "PUT", body: { apiKey: API_KEY } });
	return client;
}

async function uploadCover(client: Client, bytes = PNG_BYTES, filename = "cover.png") {
	const form = new FormData();
	// 파일명과 MIME 은 클라이언트가 정한다. 서버는 이 값을 믿지 않고 바이트로 다시 판정한다.
	form.append("cover", new File([bytes], filename, { type: "image/png" }));
	return client.upload("/api/books", form);
}

describe("책 등록", () => {
	it("표지를 올리면 R2 에 저장되고 책이 만들어진다", async () => {
		const client = await withKey();
		const res = await uploadCover(client);

		expect(res.status).toBe(201);
		const bookId = res.body.data.book.id;

		const row = await env.DB.prepare("SELECT cover_r2_key, cover_mime FROM books WHERE id = ?")
			.bind(bookId)
			.first<{ cover_r2_key: string; cover_mime: string }>();

		expect(row!.cover_mime).toBe("image/png");
		// get() 은 본문 스트림을 열어 두어 테스트 격리 스토리지가 정리되지 않는다. 존재만 확인한다.
		const object = await env.IMAGES.head(row!.cover_r2_key);
		expect(object).not.toBeNull();
		expect(object!.size).toBe(PNG_BYTES.byteLength);
	});

	it("이미지가 아닌 파일은 확장자·MIME 을 속여도 거부된다", async () => {
		const client = await withKey();
		const notAnImage = new TextEncoder().encode("<?php system($_GET['c']); ?>");
		const res = await uploadCover(client, notAnImage, "cover.png");

		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("이미지만");
	});

	it("빈 파일은 거부된다", async () => {
		const client = await withKey();
		const res = await uploadCover(client, new Uint8Array(0));
		expect(res.status).toBe(400);
	});

	it("표지는 소유자만 볼 수 있다", async () => {
		const client = await withKey();
		const { body } = await uploadCover(client);
		const bookId = body.data.book.id;

		expect((await client.get(`/api/books/${bookId}/cover`)).status).toBe(200);

		const { client: other } = await signupParent();
		expect((await other.get(`/api/books/${bookId}/cover`)).status).toBe(404);
	});

	it("다른 부모의 책은 조회·수정할 수 없다", async () => {
		const client = await withKey();
		const { body } = await uploadCover(client);
		const bookId = body.data.book.id;

		const { client: other } = await signupParent();
		expect((await other.get(`/api/books/${bookId}`)).status).toBe(404);
		expect((await other.patch(`/api/books/${bookId}`, { title: "탈취" })).status).toBe(404);
		expect((await other.post(`/api/books/${bookId}/analyze`)).status).toBe(404);
	});

	it("아이 계정은 책 API 를 쓸 수 없다", async () => {
		const { client: parent } = await signupParent();
		const { client: child } = await addChild(parent);
		expect((await child.get("/api/books")).status).toBe(403);
	});
});

describe("AI 식별", () => {
	it("표지에서 읽은 정보가 책에 반영된다", async () => {
		const client = await withKey();
		const { body } = await uploadCover(client);
		const bookId = body.data.book.id;

		mockResponses(IDENTITY);
		const res = await client.post(`/api/books/${bookId}/analyze`);

		expect(res.status).toBe(200);
		expect(res.body.data.identity.title).toBe("마당을 나온 암탉");
		expect(res.body.data.needsReview).toBe(false);
		expect(res.body.data.book.author).toBe("황선미");
		// 13자리 ISBN 은 isbn13 컬럼으로 들어간다
		expect(res.body.data.book.isbn13).toBe("9788958281252");

		// AI 원본은 외부 검색 결과와 구분해 그대로 보관한다(§6)
		const row = await env.DB.prepare("SELECT ai_extracted, ai_confidence FROM books WHERE id = ?")
			.bind(bookId)
			.first<{ ai_extracted: string; ai_confidence: number }>();
		expect(JSON.parse(row!.ai_extracted).title).toBe("마당을 나온 암탉");
		expect(row!.ai_confidence).toBeCloseTo(0.93);
	});

	it("확신이 낮으면 부모 확인이 필요하다고 알린다", async () => {
		const client = await withKey();
		const { body } = await uploadCover(client);

		mockResponses({ ...IDENTITY, confidence: 0.3 });
		const res = await client.post(`/api/books/${body.data.book.id}/analyze`);

		expect(res.body.data.needsReview).toBe(true);
	});

	it("제목을 읽지 못해도 기존 제목을 빈 값으로 덮어쓰지 않는다", async () => {
		const client = await withKey();
		const { body } = await uploadCover(client);
		const bookId = body.data.book.id;

		await client.patch(`/api/books/${bookId}`, { title: "부모가 입력한 제목" });

		mockResponses({ ...IDENTITY, title: "", confidence: 0.2 });
		const res = await client.post(`/api/books/${bookId}/analyze`);

		expect(res.body.data.book.title).toBe("부모가 입력한 제목");
		expect(res.body.data.needsReview).toBe(true);
	});

	it("API Key 가 없으면 분석할 수 없다", async () => {
		const { client } = await signupParent();
		const { body } = await uploadCover(client);

		const res = await client.post(`/api/books/${body.data.book.id}/analyze`);
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("API Key");
	});
});

describe("책 정보 검색", () => {
	it("검색 결과와 출처가 저장되고 Brief 가 만들어진다", async () => {
		const client = await withKey();
		const { body } = await uploadCover(client);
		const bookId = body.data.book.id;

		mockResponses(IDENTITY);
		await client.post(`/api/books/${bookId}/analyze`);

		mockGoogleBooksMiss();
		mockOpenLibraryMiss();
		mockResponses(RESEARCH);
		const res = await client.post(`/api/books/${bookId}/search`);

		expect(res.status).toBe(200);
		expect(res.body.data.readyForQuiz).toBe(true);
		expect(res.body.data.sourceCount).toBe(2);

		const detail = await client.get(`/api/books/${bookId}`);
		expect(detail.body.data.sources).toHaveLength(2);
		expect(detail.body.data.book.hasBrief).toBe(true);

		const row = await env.DB.prepare("SELECT brief FROM books WHERE id = ?")
			.bind(bookId)
			.first<{ brief: string }>();
		// Brief 는 문제 생성 프롬프트에 그대로 들어간다. 줄거리·인물·사건이 모두 담겨야 한다.
		expect(row!.brief).toContain("잎싹");
		expect(row!.brief).toContain("[줄거리]");
		expect(row!.brief).toContain("[등장인물]");
		expect(row!.brief).toContain("[주요 사건 — 일어난 순서]");
	});

	it("출처 발췌는 상한을 넘겨 저장되지 않는다", async () => {
		const client = await withKey();
		const { body } = await uploadCover(client);
		const bookId = body.data.book.id;

		await client.patch(`/api/books/${bookId}`, { title: "긴 발췌 책" });

		mockGoogleBooksMiss();
		mockResponses({
			...RESEARCH,
			sources: [{ url: "https://example.com/long", title: "긴 글", content: "가".repeat(5000) }],
		});
		await client.post(`/api/books/${bookId}/search`);

		const row = await env.DB.prepare("SELECT content FROM book_sources WHERE book_id = ?")
			.bind(bookId)
			.first<{ content: string }>();
		expect(row!.content.length).toBe(2000);
	});

	it("근거가 부족하면 문제 생성 준비가 안 된 것으로 표시된다", async () => {
		const client = await withKey();
		const { body } = await uploadCover(client);
		const bookId = body.data.book.id;

		await client.patch(`/api/books/${bookId}`, { title: "자료 없는 책" });

		mockGoogleBooksMiss();
		mockResponses({ ...RESEARCH, found: false, sources: [] });
		const res = await client.post(`/api/books/${bookId}/search`);

		expect(res.body.data.readyForQuiz).toBe(false);
		expect(res.body.data.sourceCount).toBe(0);

		const detail = await client.get(`/api/books/${bookId}`);
		expect(detail.body.data.book.hasBrief).toBe(false);
		// 책을 특정하지 못한 결과의 서지정보는 받아들이지 않는다. 엉뚱한 책 정보가 섞이면 안 된다.
		expect(detail.body.data.book.author).toBeNull();
		expect(detail.body.data.book.isbn13).toBeNull();
	});

	it("부모가 고친 값을 검색 결과가 덮어쓰지 않는다", async () => {
		const client = await withKey();
		const { body } = await uploadCover(client);
		const bookId = body.data.book.id;

		await client.patch(`/api/books/${bookId}`, { title: "내가 고친 제목", author: "내가 고친 저자" });

		mockGoogleBooksMiss();
		mockResponses({ ...RESEARCH, author: "검색이 찾은 다른 저자" });
		await client.post(`/api/books/${bookId}/search`);

		const detail = await client.get(`/api/books/${bookId}`);
		expect(detail.body.data.book.title).toBe("내가 고친 제목");
		expect(detail.body.data.book.author).toBe("내가 고친 저자");
	});

	it("분석 전에는 검색할 수 없다", async () => {
		const client = await withKey();
		const { body } = await uploadCover(client);

		const res = await client.post(`/api/books/${body.data.book.id}/search`);
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("제목");
	});

	it("검색을 다시 돌리면 이전 출처가 남지 않는다", async () => {
		const client = await withKey();
		const { body } = await uploadCover(client);
		const bookId = body.data.book.id;

		await client.patch(`/api/books/${bookId}`, { title: "재검색 책" });

		mockGoogleBooksMiss();
		mockResponses(RESEARCH);
		await client.post(`/api/books/${bookId}/search`);

		// 첫 검색으로 isbn13 이 채워졌으므로 두 번째에는 ISBN 경로(구글 + 오픈라이브러리)를 탄다.
		mockGoogleBooksMiss();
		mockOpenLibraryMiss();
		mockResponses({
			...RESEARCH,
			sources: [{ url: "https://example.com/new", title: "새 자료", content: "새 내용" }],
		});
		await client.post(`/api/books/${bookId}/search`);

		const detail = await client.get(`/api/books/${bookId}`);
		expect(detail.body.data.sources).toHaveLength(1);
		expect(detail.body.data.sources[0].url).toBe("https://example.com/new");
	});
});
