import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { normalizeOrientation } from "../src/ai/orient";
import { Client, signupParent } from "./helpers";

/**
 * 표지 방향 보정(§5 등록).
 *
 * 부모는 책을 손에 들고 찍는다. 폰을 가로로 들거나 책을 눕혀 두고 찍으면 제목이 옆으로 누운
 * 사진이 등록된다. 여기서 지키려는 것은 셋이다.
 *
 *  1. 각도는 **서버가** 정한다 — 모델이 뭘 보내와도 0·90·180·270 넷 중 하나다
 *  2. 확신이 낮으면 **아무것도 하지 않는다** — 똑바른 사진을 눕히는 것은 지금보다 나쁘다
 *  3. 브라우저가 돌려 올린 바이트도 **등록과 같은 검증**을 거친다(§26)
 */

const API_KEY = "sk-test1234567890abcdefghijklmn";

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

/** 브라우저가 canvas 로 돌리면 JPEG 이 되어 돌아온다. 매직 바이트만 맞으면 된다. */
const JPEG = new Uint8Array([
	0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
	0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

const mockModels = () =>
	fetchMock
		.get("https://api.openai.com")
		.intercept({ path: "/v1/models", method: "GET" })
		.reply(200, { data: [{ id: "gpt-5.6-mini" }] });

const mockResponses = (payload: unknown) =>
	fetchMock
		.get("https://api.openai.com")
		.intercept({ path: "/v1/responses", method: "POST" })
		.reply(200, {
			status: "completed",
			output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(payload) }] }],
		});

async function aBook(): Promise<{ client: Client; bookId: string }> {
	const { client } = await signupParent();
	// 키 저장은 모델 목록 조회 + 추론 가능 확인, 두 번을 부른다.
	mockModels();
	mockResponses({ ok: true });
	await client.request("/api/settings/ai-key", {
		method: "PUT",
		body: { provider: "openai", apiKey: API_KEY },
	});

	const form = new FormData();
	form.append("cover", new File([PNG], "cover.png", { type: "image/png" }));
	const created = await client.upload("/api/books", form);
	return { client, bookId: created.body.data.book.id as string };
}

const rotationOf = async (bookId: string): Promise<number | null> =>
	(
		await env.DB.prepare("SELECT cover_rotation FROM books WHERE id = ?")
			.bind(bookId)
			.first<{ cover_rotation: number | null }>()
	)!.cover_rotation;

describe("각도 정리", () => {
	it("네 값 중 하나로 좁힌다", () => {
		expect(normalizeOrientation({ rotation: "90", confidence: 0.9 }).rotation).toBe(90);
		// 45도는 회전이 아니다. 사진이 조금 기울어진 것을 돌려 봐야 더 나빠진다.
		expect(normalizeOrientation({ rotation: 45, confidence: 0.9 }).rotation).toBe(0);
		expect(normalizeOrientation({ rotation: "왼쪽", confidence: 0.9 }).rotation).toBe(0);
		expect(normalizeOrientation({}).rotation).toBe(0);
	});

	/**
	 * 확신이 낮으면 그대로 둔다. 잘못 돌리면 **똑바른 사진을 눕히는** 셈이고, 부모에게는
	 * 그것을 되돌릴 방법이 화면에 없다. 모르겠으면 아무것도 하지 않는 편이 맞다.
	 */
	it("확신이 낮으면 돌리지 않는다", () => {
		expect(normalizeOrientation({ rotation: 90, confidence: 0.2 }).rotation).toBe(0);
		// 판단이 흐렸다는 사실 자체는 남긴다.
		expect(normalizeOrientation({ rotation: 90, confidence: 0.2 }).confidence).toBeCloseTo(0.2);
	});
});

describe("방향 판정", () => {
	/** 등록 직후에는 아직 확인하지 않은 상태다. 화면이 그것을 보고 판정을 건다. */
	it("등록한 책은 아직 확인하지 않은 상태다", async () => {
		const { client, bookId } = await aBook();

		expect(await rotationOf(bookId)).toBeNull();
		const detail = await client.get(`/api/books/${bookId}`);
		expect(detail.body.data.book.coverRotation).toBeNull();
	});

	it("누운 사진은 회전량이 책에 적힌다", async () => {
		const { client, bookId } = await aBook();

		mockResponses({ rotation: "90", confidence: 0.95 });
		const res = await client.post(`/api/books/${bookId}/orient`);

		expect(res.status).toBe(200);
		expect(res.body.data.rotation).toBe(90);
		expect(res.body.data.book.coverRotation).toBe(90);
		expect(await rotationOf(bookId)).toBe(90);
	});

	/**
	 * 결과가 0 이어도 컬럼을 채운다. 그래야 이 책을 다시 열 때 같은 질문을 하지 않는다 —
	 * 확인 자체가 모델 호출이라 되풀이하면 비용이 그만큼 쌓인다.
	 */
	it("똑바른 사진도 확인했다는 표시가 남는다", async () => {
		const { client, bookId } = await aBook();

		mockResponses({ rotation: "0", confidence: 0.9 });
		await client.post(`/api/books/${bookId}/orient`);

		expect(await rotationOf(bookId)).toBe(0);
	});

	it("남의 책은 판정할 수 없다", async () => {
		const { bookId } = await aBook();
		const { client: other } = await signupParent();

		expect((await other.post(`/api/books/${bookId}/orient`)).status).toBe(404);
	});

	it("API Key 가 없으면 판정하지 않는다", async () => {
		const { client } = await signupParent();
		const form = new FormData();
		form.append("cover", new File([PNG], "cover.png", { type: "image/png" }));
		const created = await client.upload("/api/books", form);

		const res = await client.post(`/api/books/${created.body.data.book.id}/orient`);
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("API Key");
	});
});

describe("돌린 표지 갈아 끼우기", () => {
	async function replaceWith(client: Client, bookId: string, bytes: Uint8Array, name = "cover.jpg") {
		const form = new FormData();
		form.append("cover", new File([bytes], name, { type: "image/jpeg" }));
		return client.upload(`/api/books/${bookId}/cover`, form, "PUT");
	}

	it("바이트를 갈아 끼우고 남은 회전량을 0 으로 되돌린다", async () => {
		const { client, bookId } = await aBook();

		mockResponses({ rotation: "270", confidence: 0.9 });
		await client.post(`/api/books/${bookId}/orient`);
		expect(await rotationOf(bookId)).toBe(270);

		const res = await replaceWith(client, bookId, JPEG);
		expect(res.status).toBe(200);
		expect(res.body.data.book.coverRotation).toBe(0);

		const row = await env.DB.prepare("SELECT cover_key, cover_mime FROM books WHERE id = ?")
			.bind(bookId)
			.first<{ cover_key: string; cover_mime: string }>();
		// 키는 그대로 쓴다. 새 키를 만들면 예전 바이트가 KV 에 남는다.
		expect(row!.cover_key).toContain(bookId);
		expect(row!.cover_mime).toBe("image/jpeg");

		const stored = await env.IMAGES.getWithMetadata<{ contentType: string }>(
			row!.cover_key,
			"arrayBuffer",
		);
		expect(stored.value!.byteLength).toBe(JPEG.byteLength);
		expect(stored.metadata?.contentType).toBe("image/jpeg");
	});

	// 표지 주소는 `?v=` 로 갱신 시각을 달고 나간다. 같은 키 위에서 바이트가 바뀌므로
	// 주소가 그대로면 브라우저 캐시가 돌리기 전 사진을 계속 보여 준다.
	it("표지 주소가 바뀌어 캐시가 갱신된다", async () => {
		const { client, bookId } = await aBook();
		const before = (await client.get(`/api/books/${bookId}`)).body.data.book.coverUrl;

		await replaceWith(client, bookId, JPEG);
		const after = (await client.get(`/api/books/${bookId}`)).body.data.book.coverUrl;

		expect(before).toContain("?v=");
		expect(after).not.toBe(before);
	});

	it("이미지가 아닌 바이트는 거부한다", async () => {
		const { client, bookId } = await aBook();
		const notAnImage = new TextEncoder().encode("<?php system($_GET['c']); ?>");

		const res = await replaceWith(client, bookId, notAnImage);
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("이미지만");

		// 거부됐으므로 원래 사진이 그대로 있어야 한다.
		const row = await env.DB.prepare("SELECT cover_key FROM books WHERE id = ?")
			.bind(bookId)
			.first<{ cover_key: string }>();
		const stored = await env.IMAGES.get(row!.cover_key, "arrayBuffer");
		expect(stored!.byteLength).toBe(PNG.byteLength);
	});

	it("남의 책 표지는 갈아 끼울 수 없다", async () => {
		const { bookId } = await aBook();
		const { client: other } = await signupParent();

		expect((await replaceWith(other, bookId, JPEG)).status).toBe(404);
	});
});
