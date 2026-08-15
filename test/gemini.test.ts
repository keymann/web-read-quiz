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

/** 실제 응답 형태에 맞춘 목록. 임베딩·이미지·TTS 와 generateContent 미지원이 섞여 온다. */
const MODEL_LIST = {
	models: [
		{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
		{ name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
		{ name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
		{ name: "models/gemini-3.5-pro", supportedGenerationMethods: ["generateContent"] },
		{ name: "models/gemini-3.7-flash", supportedGenerationMethods: ["generateContent"] },
		{ name: "models/gemini-3-flash-preview", supportedGenerationMethods: ["generateContent"] },
		{ name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
		{ name: "models/gemini-2.5-flash-image", supportedGenerationMethods: ["generateContent"] },
		{ name: "models/gemini-2.5-flash-native-audio", supportedGenerationMethods: ["generateContent"] },
		{ name: "models/imagen-4.0-generate-001", supportedGenerationMethods: ["predict"] },
		{ name: "models/gemma-3-27b-it", supportedGenerationMethods: ["generateContent"] },
	],
};

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

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

function mockKeySave(times = 1) {
	mockGeminiModels(times);
	mockGenerate(times);
}

const saveGeminiKey = (client: Client) =>
	client.request("/api/settings/ai-key", {
		method: "PUT",
		body: { provider: "gemini", apiKey: GEMINI_KEY },
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
		mockKeySave(1);

		const res = await client.request("/api/settings/ai-key", {
			method: "PUT",
			body: { provider: "gemini", apiKey: "AQ.Ab8RN6Jtestkey0123456789abcdefghijklmnopqr" },
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

	it("유효한 키는 저장되고 무료 티어에서 쓸 수 있는 flash 가 기본이 된다", async () => {
		const { client } = await signupParent();
		mockKeySave(1);

		const saved = await saveGeminiKey(client);

		expect(saved.status).toBe(200);
		expect(saved.body.data.provider).toBe("gemini");
		expect(saved.body.data.warning).toBeNull();
		// 최신 세대의 flash 가 먼저. pro 는 유료 전용이라 자동 선택되지 않게 뒤로 민다.
		expect(saved.body.data.model).toBe("gemini-3.7-flash");

		const view = await client.get("/api/settings");
		expect(view.body.data.provider).toBe("gemini");
		expect(view.body.data.ai.configured).toBe(true);
		expect(view.body.data.ai.keyHint).toBe(`끝 4자리 ${GEMINI_KEY.slice(-4)}`);
	});

	it("쓸 수 없는 모델을 걸러내고 선호 순서로 정렬한다", async () => {
		const { client } = await signupParent();
		mockKeySave(1);

		const models: string[] = (await saveGeminiKey(client)).body.data.models;

		// generateContent 를 지원하지 않거나 문제 생성에 못 쓰는 계열은 빠진다
		expect(models).not.toContain("gemini-embedding-001");
		expect(models).not.toContain("imagen-4.0-generate-001");
		expect(models).not.toContain("gemma-3-27b-it");
		expect(models).not.toContain("gemini-2.5-flash-image");
		expect(models).not.toContain("gemini-2.5-flash-native-audio");

		// 최신 세대 우선, 같은 세대에서는 flash → flash-lite → pro
		expect(models[0]).toBe("gemini-3.7-flash");
		expect(models.indexOf("gemini-3.5-flash")).toBeLessThan(models.indexOf("gemini-3.5-flash-lite"));
		expect(models.indexOf("gemini-3.5-flash-lite")).toBeLessThan(models.indexOf("gemini-3.5-pro"));
		// preview 는 예고 없이 바뀌므로 뒤로
		expect(models.indexOf("gemini-3.5-flash")).toBeLessThan(models.indexOf("gemini-3-flash-preview"));
	});

	it("잘못된 키는 400 INVALID_ARGUMENT 로 오며 저장되지 않는다", async () => {
		const { client } = await signupParent();
		// Gemini 는 잘못된 키도 400 으로 준다. 상태 코드만으로는 구분되지 않는다.
		mockGeminiModels(1, 400, {
			error: { status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." },
		});

		const res = await saveGeminiKey(client);
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("invalid");
		expect(res.body.error.message).toContain("Gemini");

		expect((await client.get("/api/settings")).body.data.ai.configured).toBe(false);
	});

	// Cloudflare Worker 에서 나가는 요청을 Google 이 위치 기준으로 막는다(실측 확인).
	// 같은 키로 로컬에서는 잘 되기 때문에, 이 사실을 알려주지 않으면 키를 몇 번이고 다시 넣어 보게 된다.
	it("서버 위치가 차단되면 그 사실을 그대로 알려준다", async () => {
		const { client } = await signupParent();
		mockGeminiModels(1, 400, {
			error: {
				code: 400,
				status: "FAILED_PRECONDITION",
				message: "User location is not supported for the API use.",
			},
		});

		const res = await saveGeminiKey(client);

		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("region_blocked");
		expect(res.body.error.message).toContain("지역");
		// OpenAI 로 가라는 안내가 함께 있어야 한다
		expect(res.body.error.message).toContain("OpenAI");

		// 쓸 수 없는 키를 저장해 두면 나중에 더 헷갈린다
		expect((await client.get("/api/settings")).body.data.ai.configured).toBe(false);
	});

	it("DB 에는 평문이 아니라 암호문이 저장된다", async () => {
		const { client } = await signupParent();
		mockKeySave(1);
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

		// 먼저 OpenAI 키를 등록한다
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
		mockKeySave(1);
		await saveGeminiKey(client);

		const view = await client.get("/api/settings");
		expect(view.body.data.provider).toBe("gemini");
		expect(view.body.data.ai.model).toBe("gemini-3.7-flash");
		expect(view.body.data.ai.keyHint).toBe(`끝 4자리 ${GEMINI_KEY.slice(-4)}`);
	});
});

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
		mockKeySave(1);
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
