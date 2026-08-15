import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { addChild, signupParent } from "./helpers";

/**
 * OpenAI 는 실제로 부르지 않는다. fetchMock 으로 `api.openai.com` 응답을 가로챈다.
 * (`global_fetch_strictly_public` 컴파일 플래그가 켜져 있어야 동작한다)
 */
const API_KEY = "sk-test1234567890abcdefghijklmn";

const MODEL_LIST = {
	data: [
		{ id: "gpt-4o" },
		{ id: "text-embedding-3-small" },
		{ id: "gpt-5.6-mini" },
		{ id: "gpt-image-2" },
		{ id: "gpt-4o-mini-tts" },
	],
};

/** 실제 계정의 `GET /v1/models` 응답에서 가져온 목록(2026-08 기준). */
const REAL_WORLD_MODELS = [
	"gpt-5.6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.5",
	"gpt-5.5-2026-04-23",
	"gpt-5.5-pro",
	"gpt-5.5-pro-2026-04-23",
	"gpt-5",
	"gpt-5-2025-08-07",
	"gpt-5-chat-latest",
	"gpt-5-mini",
	"gpt-5-nano",
	"gpt-5-pro",
	"gpt-5.1",
	"gpt-5.1-chat-latest",
	"gpt-5.2",
	"gpt-5.2-pro",
	"gpt-5.3-chat-latest",
	"gpt-5.4",
	"gpt-5.4-2026-03-05",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.4-pro",
	"gpt-4.1",
	"gpt-4.1-mini",
	"gpt-4.1-nano",
	"gpt-4o",
	"gpt-4o-mini",
	"gpt-3.5-turbo",
	"gpt-3.5-turbo-instruct",
	"o1",
	"o3",
	"o3-mini",
	"o4-mini",
	"gpt-image-2",
	"gpt-4o-mini-tts",
	"text-embedding-3-small",
	"omni-moderation-latest",
];

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

function mockModels(times = 1, status = 200, body: unknown = MODEL_LIST) {
	fetchMock
		.get("https://api.openai.com")
		.intercept({ path: "/v1/models", method: "GET" })
		.reply(status, body)
		.times(times);
}

describe("OpenAI API Key 설정", () => {
	it("등록 전에는 configured=false", async () => {
		const { client } = await signupParent();
		const res = await client.get("/api/settings");

		expect(res.status).toBe(200);
		expect(res.body.data.openai.configured).toBe(false);
		expect(res.body.data.openai.last4).toBeNull();
	});

	it("sk- 로 시작하지 않으면 OpenAI 를 부르지 않고 거절한다", async () => {
		const { client } = await signupParent();
		const res = await client.request("/api/settings/openai-key", {
			method: "PUT",
			body: { apiKey: "not-a-key-but-long-enough-string" },
		});

		expect(res.status).toBe(400);
		// 인터셉터를 걸지 않았으므로, 호출이 있었다면 disableNetConnect 로 실패했을 것이다.
	});

	it("유효한 키는 검증 후 저장되고 기본 모델이 잡힌다", async () => {
		const { client } = await signupParent();
		mockModels(1);

		const saved = await client.request("/api/settings/openai-key", {
			method: "PUT",
			body: { apiKey: API_KEY },
		});

		expect(saved.status).toBe(200);
		expect(saved.body.data.last4).toBe("klmn");
		// 선호 순서상 gpt-5.6 계열이 먼저, 임베딩·이미지·TTS 는 제외
		expect(saved.body.data.models).toEqual(["gpt-5.6-mini", "gpt-4o"]);
		expect(saved.body.data.model).toBe("gpt-5.6-mini");

		const view = await client.get("/api/settings");
		expect(view.body.data.openai.configured).toBe(true);
		expect(view.body.data.openai.last4).toBe("klmn");
		expect(view.body.data.openai.model).toBe("gpt-5.6-mini");
	});

	// 실제 계정에서 돌아온 목록을 그대로 넣어 정렬·필터가 의도대로 도는지 고정한다.
	it("실제 모델 목록에서 쓸 수 없는 모델과 날짜 스냅샷을 걸러낸다", async () => {
		const { client } = await signupParent();
		mockModels(1, 200, { data: REAL_WORLD_MODELS.map((id) => ({ id })) });

		const saved = await client.request("/api/settings/openai-key", {
			method: "PUT",
			body: { apiKey: API_KEY },
		});

		const models: string[] = saved.body.data.models;

		// 채팅/구조화 출력을 못 하거나 대상이 조용히 바뀌는 것들은 후보에서 빠진다
		expect(models).not.toContain("gpt-3.5-turbo");
		expect(models).not.toContain("gpt-3.5-turbo-instruct");
		expect(models).not.toContain("gpt-5.1-chat-latest");
		expect(models).not.toContain("gpt-image-2");
		expect(models).not.toContain("text-embedding-3-small");
		// 날짜 스냅샷은 기본 별칭과 중복이라 숨긴다
		expect(models).not.toContain("gpt-5.5-2026-04-23");
		expect(models.some((id) => /-\d{4}-\d{2}-\d{2}$/.test(id))).toBe(false);

		// 최신 세대가 앞, 같은 세대 안에서는 기본 별칭 → mini/nano → pro 순
		expect(models[0]).toMatch(/^gpt-5\.6/);
		expect(models.indexOf("gpt-5.5")).toBeLessThan(models.indexOf("gpt-5.5-pro"));
		expect(models.indexOf("gpt-5.4")).toBeLessThan(models.indexOf("gpt-5.4-mini"));
		expect(models.indexOf("gpt-5.4-mini")).toBeLessThan(models.indexOf("gpt-5.4-pro"));
		// 세대 우선순위가 변종보다 강하다
		expect(models.indexOf("gpt-5.5-pro")).toBeLessThan(models.indexOf("gpt-5.4"));
		// o 시리즈는 남기되 뒤로
		expect(models).toContain("o3");
		expect(models.indexOf("gpt-4o")).toBeLessThan(models.indexOf("o3"));

		// 기본값은 목록 맨 앞이 그대로 잡힌다
		expect((await client.get("/api/settings")).body.data.openai.model).toBe(models[0]);
	});

	it("어떤 응답에도 키 원문이 담기지 않는다", async () => {
		const { client } = await signupParent();
		mockModels(1);
		const saved = await client.request("/api/settings/openai-key", { method: "PUT", body: { apiKey: API_KEY } });
		const view = await client.get("/api/settings");

		expect(JSON.stringify(saved.body)).not.toContain(API_KEY);
		expect(JSON.stringify(view.body)).not.toContain(API_KEY);
	});

	it("DB 에는 평문이 아니라 암호문이 저장된다", async () => {
		const { client } = await signupParent();
		mockModels(1);
		await client.request("/api/settings/openai-key", { method: "PUT", body: { apiKey: API_KEY } });

		const rows = await env.DB.prepare(
			"SELECT openai_api_key_cipher AS c, openai_api_key_iv AS iv FROM parent_settings WHERE openai_api_key_cipher IS NOT NULL",
		).all<{ c: string; iv: string }>();

		expect(rows.results.length).toBeGreaterThan(0);
		for (const row of rows.results) {
			expect(row.c).not.toContain(API_KEY);
			expect(row.c).not.toContain("sk-");
			expect(row.iv).toBeTruthy();
		}
	});

	it("같은 키를 두 번 저장해도 암호문이 달라진다", async () => {
		const { client } = await signupParent();
		mockModels(2);

		await client.request("/api/settings/openai-key", { method: "PUT", body: { apiKey: API_KEY } });
		const first = await currentCipher(client);

		await client.request("/api/settings/openai-key", { method: "PUT", body: { apiKey: API_KEY } });
		const second = await currentCipher(client);

		expect(first).not.toBe(second);
	});

	it("OpenAI 가 401 을 주면 저장하지 않는다", async () => {
		const { client } = await signupParent();
		mockModels(1, 401, { error: { message: "Incorrect API key provided" } });

		const res = await client.request("/api/settings/openai-key", { method: "PUT", body: { apiKey: API_KEY } });
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("invalid");

		expect((await client.get("/api/settings")).body.data.openai.configured).toBe(false);
	});

	it("쓸 수 있는 모델이 없으면 저장하지 않는다", async () => {
		const { client } = await signupParent();
		mockModels(1, 200, { data: [{ id: "text-embedding-3-small" }] });

		const res = await client.request("/api/settings/openai-key", { method: "PUT", body: { apiKey: API_KEY } });
		expect(res.status).toBe(400);
		expect((await client.get("/api/settings")).body.data.openai.configured).toBe(false);
	});

	it("삭제하면 configured 가 false 로 돌아간다", async () => {
		const { client } = await signupParent();
		mockModels(1);
		await client.request("/api/settings/openai-key", { method: "PUT", body: { apiKey: API_KEY } });

		expect((await client.del("/api/settings/openai-key")).status).toBe(200);
		expect((await client.get("/api/settings")).body.data.openai.configured).toBe(false);
	});
});

describe("모델 선택", () => {
	it("계정에 없는 모델은 저장할 수 없다", async () => {
		const { client } = await signupParent();
		mockModels(2); // 키 저장 1회 + 모델 검증 1회

		await client.request("/api/settings/openai-key", { method: "PUT", body: { apiKey: API_KEY } });

		const res = await client.request("/api/settings/openai/models", {
			method: "PUT",
			body: { model: "gpt-does-not-exist" },
		});
		expect(res.status).toBe(400);
	});

	it("계정에 있는 모델은 저장된다", async () => {
		const { client } = await signupParent();
		mockModels(2);

		await client.request("/api/settings/openai-key", { method: "PUT", body: { apiKey: API_KEY } });
		const res = await client.request("/api/settings/openai/models", {
			method: "PUT",
			body: { model: "gpt-4o" },
		});

		expect(res.status).toBe(200);
		expect((await client.get("/api/settings")).body.data.openai.model).toBe("gpt-4o");
	});

	it("키가 없으면 모델 목록을 조회할 수 없다", async () => {
		const { client } = await signupParent();
		const res = await client.get("/api/settings/openai/models");
		expect(res.status).toBe(400);
	});
});

describe("설정 권한", () => {
	it("아이 계정은 설정에 접근할 수 없다", async () => {
		const { client: parent } = await signupParent();
		const { client: child } = await addChild(parent);

		expect((await child.get("/api/settings")).status).toBe(403);
		expect((await child.request("/api/settings/openai-key", { method: "PUT", body: { apiKey: API_KEY } })).status).toBe(403);
		expect((await child.del("/api/settings/openai-key")).status).toBe(403);
	});

	it("로그인하지 않으면 401", async () => {
		const { Client } = await import("./helpers");
		const anon = new Client("10.9.9.9");
		expect((await anon.get("/api/settings")).status).toBe(401);
	});

	it("다른 부모의 키는 보이지 않는다", async () => {
		const { client: parentA } = await signupParent();
		mockModels(1);
		await parentA.request("/api/settings/openai-key", { method: "PUT", body: { apiKey: API_KEY } });

		const { client: parentB } = await signupParent();
		expect((await parentB.get("/api/settings")).body.data.openai.configured).toBe(false);
	});
});

async function currentCipher(client: { get: (p: string) => Promise<{ body: any }> }): Promise<string> {
	const view = await client.get("/api/settings");
	const last4 = view.body.data.openai.last4 as string;
	const row = await env.DB.prepare(
		"SELECT openai_api_key_cipher AS c FROM parent_settings WHERE openai_api_key_last4 = ? ORDER BY updated_at DESC LIMIT 1",
	)
		.bind(last4)
		.first<{ c: string }>();
	return row!.c;
}
