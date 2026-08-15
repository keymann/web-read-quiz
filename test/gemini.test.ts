import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { toGeminiSchema } from "../src/ai/google-shared";
import { BOOK_IDENTITY_SCHEMA } from "../src/ai/schemas";
import { Client, signupParent } from "./helpers";

/**
 * Gemini 제공자. 실제 호출 없이 `generativelanguage.googleapis.com` 을 가로챈다.
 * OpenAI 와 같은 시나리오가 같은 결과를 내는지 확인하는 것이 목적이다.
 */
const GEMINI_KEY = "AIzaSyTestKey0123456789abcdefghijklmno";
const OPENAI_KEY = "sk-test1234567890abcdefghijklmn";

const GEMINI_HOST = "https://generativelanguage.googleapis.com";

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

/** 실제 응답 형태에 맞춘 목록. 임베딩·이미지·TTS 와 generateContent 미지원이 섞여 온다. */
const MODEL_LIST = {
	models: [
		{ name: "models/gemini-3.7-flash", supportedGenerationMethods: ["generateContent"] },
		{ name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
		{ name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
		{ name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
	],
};

function mockGeminiModels(times = 1, status = 200, body: unknown = MODEL_LIST) {
	fetchMock
		.get(GEMINI_HOST)
		.intercept({ path: (p) => p.startsWith("/v1beta/models?"), method: "GET" })
		.reply(status, body)
		.times(times);
}

function mockGenerate(times = 1, status = 200, body: unknown = { candidates: [] }) {
	fetchMock
		.get(GEMINI_HOST)
		.intercept({ path: (p) => p.includes(":generateContent"), method: "POST" })
		.reply(status, body)
		.times(times);
}

/**
 * Gemini 는 **서버가 부를 수 없다**(요청 위치 차단). 그래서 키 저장 시 서버는 Gemini 를
 * 한 번도 부르지 않고, 브라우저가 조회해 온 모델 목록을 그대로 받는다.
 * 인터셉터를 걸지 않았는데도 저장이 되는 것 자체가 그 증거다.
 */
const BROWSER_MODELS = ["gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];

const saveGeminiKey = (client: Client, models: string[] = BROWSER_MODELS) =>
	client.request("/api/settings/ai-key", {
		method: "PUT",
		body: { provider: "gemini", apiKey: GEMINI_KEY, models },
	});

describe("Gemini 키 설정", () => {
	// 키 형식을 화이트리스트로 막지 않는다. Google 은 AIza… 말고 AQ.… 형식도 발급한다.
	// 사전 검사는 "다른 제공자의 키를 붙여넣은" 명백한 실수만 잡는다.
	it("OpenAI 키를 Gemini 로 저장하려 하면 제공자를 바꾸라고 알려준다", async () => {
		const { client } = await signupParent();
		const res = await client.request("/api/settings/ai-key", {
			method: "PUT",
			body: { provider: "gemini", apiKey: "sk-this-is-an-openai-key-shape" },
		});

		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("OpenAI");
	});

	it("AIza 가 아닌 형식(AQ. 등)의 Google 키도 받아들인다", async () => {
		const { client } = await signupParent();

		const res = await client.request("/api/settings/ai-key", {
			method: "PUT",
			body: {
				provider: "gemini",
				apiKey: "AQ.Ab8RN6Jtestkey0123456789abcdefghijklmnopqr",
				models: BROWSER_MODELS,
			},
		});

		expect(res.status).toBe(200);
	});

	it("공백이 섞인 키는 잘라 붙여넣으라고 알려준다", async () => {
		const { client } = await signupParent();
		const res = await client.request("/api/settings/ai-key", {
			method: "PUT",
			body: { provider: "gemini", apiKey: "AIzaSyTest 0123456789abcdefghij" },
		});

		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("공백");
	});

	it("브라우저가 조회한 목록으로 저장되고 첫 모델이 기본이 된다", async () => {
		const { client } = await signupParent();

		const saved = await saveGeminiKey(client);

		expect(saved.status).toBe(200);
		expect(saved.body.data.provider).toBe("gemini");
		expect(saved.body.data.warning).toBeNull();
		expect(saved.body.data.model).toBe("gemini-3.7-flash");

		const view = await client.get("/api/settings");
		expect(view.body.data.provider).toBe("gemini");
		expect(view.body.data.ai.configured).toBe(true);
		expect(view.body.data.ai.keyHint).toBe(`끝 4자리 ${GEMINI_KEY.slice(-4)}`);
	});

	// 목록을 브라우저가 가져와도 "무엇을 쓸 수 있고 무엇이 먼저인지" 는 서버가 정한다.
	// 조작된 목록을 그대로 믿으면 못 쓰는 모델이 기본값으로 박힌다.
	it("브라우저가 보낸 목록도 서버 기준으로 거르고 정렬한다", async () => {
		const { client } = await signupParent();

		const saved = await saveGeminiKey(client, [
			"gemini-embedding-001",
			"gemma-3-27b-it",
			"gemini-2.5-flash-image",
			"gpt-5.6-mini",
			"gemini-3.5-flash-lite",
			"gemini-3.7-flash",
			"gemini-3.5-flash",
		]);

		expect(saved.status).toBe(200);
		const models: string[] = saved.body.data.models;
		expect(models).toEqual(["gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"]);
		expect(saved.body.data.model).toBe("gemini-3.7-flash");
	});

	// 쓸 수 있는 게 하나도 없으면 저장할 이유가 없다.
	it("쓸 수 없는 모델만 보내면 거부한다", async () => {
		const { client } = await signupParent();
		const res = await saveGeminiKey(client, ["gemini-embedding-001", "gpt-5.6-mini"]);

		expect(res.status).toBe(400);
		expect((await client.get("/api/settings")).body.data.ai.configured).toBe(false);
	});

	// 서버가 Gemini 를 못 부르므로 목록을 못 받으면 저장할 근거가 없다.
	it("모델 목록 없이 저장하려 하면 거부한다", async () => {
		const { client } = await signupParent();
		const res = await client.request("/api/settings/ai-key", {
			method: "PUT",
			body: { provider: "gemini", apiKey: GEMINI_KEY },
		});

		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("모델 목록");
		expect((await client.get("/api/settings")).body.data.ai.configured).toBe(false);
	});

	it("DB 에는 평문이 아니라 암호문이 저장된다", async () => {
		const { client } = await signupParent();
		await saveGeminiKey(client);

		const row = await env.DB.prepare(
			"SELECT ai_provider AS p, api_key_cipher AS c FROM parent_settings WHERE api_key_last4 = ?",
		)
			.bind(`끝 4자리 ${GEMINI_KEY.slice(-4)}`)
			.first<{ p: string; c: string }>();

		expect(row!.p).toBe("gemini");
		expect(row!.c).not.toContain(GEMINI_KEY);
		expect(row!.c).not.toContain("AIza");
	});

	it("지원하지 않는 제공자는 거부된다", async () => {
		const { client } = await signupParent();
		const res = await client.request("/api/settings/ai-key", {
			method: "PUT",
			body: { provider: "anthropic", apiKey: GEMINI_KEY },
		});
		expect(res.status).toBe(400);
	});
});

describe("제공자 전환", () => {
	it("OpenAI 에서 Gemini 로 바꾸면 이전 모델 선택이 남지 않는다", async () => {
		const { client } = await signupParent();

		// 먼저 OpenAI 키를 등록한다 (OpenAI 는 서버가 부를 수 있다)
		fetchMock
			.get("https://api.openai.com")
			.intercept({ path: "/v1/models", method: "GET" })
			.reply(200, { data: [{ id: "gpt-5.6-mini" }] });
		fetchMock
			.get("https://api.openai.com")
			.intercept({ path: "/v1/responses", method: "POST" })
			.reply(200, { status: "completed", output: [] });

		await client.request("/api/settings/ai-key", {
			method: "PUT",
			body: { provider: "openai", apiKey: OPENAI_KEY },
		});
		expect((await client.get("/api/settings")).body.data.ai.model).toBe("gpt-5.6-mini");

		// Gemini 로 교체하면 OpenAI 모델 이름이 남아 있으면 안 된다.
		// 남으면 다음 호출이 "gpt-5.6-mini" 를 Gemini 에 보내 404 로 실패한다.
		await saveGeminiKey(client);

		const view = await client.get("/api/settings");
		expect(view.body.data.provider).toBe("gemini");
		expect(view.body.data.ai.model).toBe("gemini-3.7-flash");
		expect(view.body.data.ai.keyHint).toBe(`끝 4자리 ${GEMINI_KEY.slice(-4)}`);
	});
});

// 폴백은 서버가 제공자를 직접 부르는 경로의 동작이다. 지역 차단이 없는 로컬 실행에서
// Gemini 를 쓰는 경우가 여기 해당한다.
describe("모델 폴백", () => {
	/** 표지 분석까지 가려면 책이 필요하다. 최소 PNG 하나면 된다. */
	const PNG = new Uint8Array([
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
		isbn: "",
		series: "",
		confidence: 0.9,
	};

	const structuredReply = (payload: unknown) => ({
		candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: "STOP" }],
	});

	async function bookWithGeminiKey() {
		const { client } = await signupParent();
		await saveGeminiKey(client);

		const form = new FormData();
		form.append("cover", new File([PNG], "cover.png", { type: "image/png" }));
		const uploaded = await client.upload("/api/books", form);
		return { client, bookId: uploaded.body.data.book.id as string };
	}

	it("모델이 과부하(503)면 다른 모델로 자동 전환한다", async () => {
		const { client, bookId } = await bookWithGeminiKey();

		// 1) 고른 모델(gemini-3.7-flash)은 계속 503 — 재시도 3회를 모두 소진한다
		mockGenerate(3, 503, { error: { status: "UNAVAILABLE", message: "high demand" } });
		// 2) 폴백 후보를 얻기 위해 목록을 다시 조회한다
		mockGeminiModels(1);
		// 3) 다음 모델은 정상 응답
		mockGenerate(1, 200, structuredReply(IDENTITY));

		const res = await client.post(`/api/books/${bookId}/analyze`);

		expect(res.status).toBe(200);
		expect(res.body.data.identity.title).toBe("마당을 나온 암탉");
		// 조용히 바꾸지 않고 부모에게 알린다
		expect(res.body.data.modelNotice).toContain("gemini-3.7-flash");
	});

	it("폴백이 없었으면 알림도 없다", async () => {
		const { client, bookId } = await bookWithGeminiKey();
		mockGenerate(1, 200, structuredReply(IDENTITY));

		const res = await client.post(`/api/books/${bookId}/analyze`);

		expect(res.status).toBe(200);
		expect(res.body.data.modelNotice).toBeNull();
	});

	it("키가 잘못된 경우에는 다른 모델로 넘어가지 않는다", async () => {
		const { client, bookId } = await bookWithGeminiKey();
		// 모델을 바꿔도 결과가 같은 오류다. 목록 조회 인터셉터를 걸지 않았으므로
		// 폴백을 시도했다면 disableNetConnect 로 실패했을 것이다.
		mockGenerate(1, 400, {
			error: { status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." },
		});

		const res = await client.post(`/api/books/${bookId}/analyze`);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("invalid");
	});
});

describe("Gemini 스키마 변환", () => {
	it("OpenAI 용 JSON Schema 를 Gemini 방언으로 바꾼다", () => {
		const converted = toGeminiSchema(BOOK_IDENTITY_SCHEMA as unknown as Record<string, unknown>);

		// type 은 대문자 열거형
		expect(converted.type).toBe("OBJECT");
		expect((converted.properties as any).title.type).toBe("STRING");
		expect((converted.properties as any).confidence.type).toBe("NUMBER");

		// Gemini 는 additionalProperties 를 받지 않는다
		expect(converted).not.toHaveProperty("additionalProperties");

		// 필드 순서를 고정하면 출력이 안정된다
		expect(converted.propertyOrdering).toEqual([
			"title",
			"author",
			"publisher",
			"isbn",
			"series",
			"confidence",
		]);

		// required 와 description 은 그대로 남는다
		expect(converted.required).toContain("confidence");
		expect((converted.properties as any).isbn.description).toContain("ISBN");
	});

	it("중첩된 배열·객체도 재귀적으로 변환한다", () => {
		const converted = toGeminiSchema({
			type: "object",
			properties: {
				items: {
					type: "array",
					items: {
						type: "object",
						properties: { name: { type: "string" } },
						required: ["name"],
						additionalProperties: false,
					},
				},
			},
			required: ["items"],
			additionalProperties: false,
		});

		const items = (converted.properties as any).items;
		expect(items.type).toBe("ARRAY");
		expect(items.items.type).toBe("OBJECT");
		expect(items.items.properties.name.type).toBe("STRING");
		expect(items.items).not.toHaveProperty("additionalProperties");
		expect(items.items.propertyOrdering).toEqual(["name"]);
	});
});
