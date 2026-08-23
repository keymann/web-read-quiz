import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client, signupParent } from "./helpers";

/**
 * Vertex AI 제공자.
 *
 * AI Studio 의 Gemini API 는 요청을 보낸 서버의 위치를 보고 막는다. Cloudflare Worker 에서
 * 부르면 걸린다(실측). Vertex 는 위치를 보지 않는 대신 API Key 가 아니라 서비스 계정으로
 * 인증한다 — 그 흐름이 제대로 도는지 확인한다.
 */

const GOOGLE_AUTH = "https://oauth2.googleapis.com";
const VERTEX = "https://aiplatform.googleapis.com";

/**
 * 테스트용 서비스 계정.
 *
 * private_key 는 **실제로 서명이 되어야** 한다(WebCrypto 가 PKCS#8 을 파싱하므로 형식만
 * 흉내 낼 수 없다). RSA 키를 한 번 만들어 두고 계정 식별자만 바꿔 쓴다.
 *
 * 액세스 토큰은 `client_email:private_key_id` 기준으로 캐시되므로, 테스트마다 다른 계정을
 * 써야 토큰 교환이 실제로 일어난다. 같은 계정을 쓰면 두 번째 테스트부터는 캐시가 걸려
 * 토큰 인터셉터가 소비되지 않는다(캐시가 의도대로 도는 증거이기도 하다).
 */
let PEM = "";
let counter = 0;

function accountJson(projectId: string): string {
	return JSON.stringify({
		type: "service_account",
		project_id: projectId,
		private_key_id: `key-${projectId}`,
		private_key: PEM,
		client_email: `quiz@${projectId}.iam.gserviceaccount.com`,
	});
}

/** 테스트마다 새 계정. 토큰 캐시가 서로 간섭하지 않는다. */
const freshAccount = () => accountJson(`quiz-project-${++counter}`);

beforeAll(async () => {
	fetchMock.activate();
	fetchMock.disableNetConnect();

	const pair = await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	);
	const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);

	let binary = "";
	for (const byte of new Uint8Array(pkcs8)) binary += String.fromCharCode(byte);
	PEM = `-----BEGIN PRIVATE KEY-----\n${btoa(binary).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

/** 토큰 교환. 아이솔레이트 캐시가 있어 계정마다 한 번만 불린다. */
function mockToken(times = 1) {
	fetchMock
		.get(GOOGLE_AUTH)
		.intercept({ path: "/token", method: "POST" })
		.reply(200, { access_token: "ya29.test-token", expires_in: 3600, token_type: "Bearer" })
		.times(times);
}

function mockModelList(times = 1, status = 200, body?: unknown) {
	fetchMock
		.get(VERTEX)
		.intercept({ path: (p) => p.startsWith("/v1beta1/publishers/google/models"), method: "GET" })
		.reply(
			status,
			body ?? {
				publisherModels: [
					{ name: "publishers/google/models/gemini-2.5-flash" },
					{ name: "publishers/google/models/gemini-3.5-flash" },
					{ name: "publishers/google/models/gemini-3.5-pro" },
					{ name: "publishers/google/models/gemini-3.7-flash" },
					{ name: "publishers/google/models/text-embedding-005" },
					{ name: "publishers/google/models/imagen-4.0-generate-001" },
				],
			},
		)
		.times(times);
}

function mockGenerate(times = 1, status = 200, body?: unknown) {
	fetchMock
		.get(VERTEX)
		.intercept({ path: (p) => p.includes(":generateContent"), method: "POST" })
		.reply(status, body ?? { candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }] })
		.times(times);
}

const saveVertex = (client: Client, json: string) =>
	client.request("/api/settings/ai-key", {
		method: "PUT",
		body: { provider: "vertex", apiKey: json },
	});

describe("Vertex 자격증명", () => {
	it("서비스 계정 JSON 으로 등록하면 프로젝트 이름을 보여준다", async () => {
		const { client } = await signupParent();
		mockToken(1);
		mockModelList(1);
		mockGenerate(1);

		const saved = await saveVertex(client, accountJson("my-quiz-project"));

		expect(saved.status).toBe(200);
		expect(saved.body.data.provider).toBe("vertex");
		// 서비스 계정에는 "끝 4자리" 가 없다. 부모가 알아볼 수 있는 건 프로젝트 이름이다.
		expect(saved.body.data.keyHint).toBe("my-quiz-project");
		expect(saved.body.data.warning).toBeNull();

		const view = await client.get("/api/settings");
		expect(view.body.data.provider).toBe("vertex");
		expect(view.body.data.ai.keyHint).toBe("my-quiz-project");
	});

	it("쓸 수 없는 모델을 걸러내고 선호 순서로 정렬한다", async () => {
		const { client } = await signupParent();
		mockToken(1);
		mockModelList(1);
		mockGenerate(1);

		const models: string[] = (await saveVertex(client, freshAccount())).body.data.models;

		expect(models).not.toContain("text-embedding-005");
		expect(models).not.toContain("imagen-4.0-generate-001");
		/*
		 * `gemini-2.5-flash` 가 맨 앞이다. 무료 등급에서 이 세대가 가장 안정적으로 응답한다
		 * (`ai/google-shared.ts` 의 `FAMILY_PREFERENCE`). Vertex 는 유료 경로지만 정렬 기준을
		 * 두 벌로 두지 않는다 — 부모가 설정에서 직접 고를 수 있고, 기준이 갈리면 어긋난다.
		 */
		expect(models[0]).toBe("gemini-2.5-flash");
		// 같은 세대 안에서는 flash 가 pro 보다 앞이다. pro 는 비싸다.
		expect(models.indexOf("gemini-3.5-flash")).toBeLessThan(models.indexOf("gemini-3.5-pro"));
	});

	it("서비스 계정이 아닌 JSON 은 무엇이 잘못됐는지 알려준다", async () => {
		const { client } = await signupParent();

		const notJson = await saveVertex(client, "this-is-not-json-but-long-enough-to-pass");
		expect(notJson.status).toBe(400);
		expect(notJson.body.error.message).toContain("읽을 수 없습니다");

		const wrongType = await saveVertex(client, JSON.stringify({ type: "authorized_user", project_id: "x" }));
		expect(wrongType.status).toBe(400);
		expect(wrongType.body.error.message).toContain("service_account");

		const missing = await saveVertex(
			client,
			JSON.stringify({ type: "service_account", project_id: "x", client_email: "a@b.c" }),
		);
		expect(missing.status).toBe(400);
		expect(missing.body.error.message).toContain("private_key");
	});

	it("권한이 없으면 무엇을 해야 하는지 알려준다", async () => {
		const { client } = await signupParent();
		mockToken(1);
		mockModelList(1, 403, {
			error: { code: 403, status: "PERMISSION_DENIED", message: "Permission denied on resource project." },
		});

		const res = await saveVertex(client, freshAccount());

		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("Vertex AI");
		// 쓸 수 없는 자격증명은 저장하지 않는다
		expect((await client.get("/api/settings")).body.data.ai.configured).toBe(false);
	});

	it("토큰 발급이 실패하면 그 사유를 전달한다", async () => {
		const { client } = await signupParent();
		fetchMock
			.get(GOOGLE_AUTH)
			.intercept({ path: "/token", method: "POST" })
			.reply(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });

		const res = await saveVertex(client, freshAccount());

		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("서비스 계정");
	});

	it("DB 에는 서비스 계정 JSON 이 평문으로 남지 않는다", async () => {
		const { client } = await signupParent();
		mockToken(1);
		mockModelList(1);
		mockGenerate(1);
		const account = accountJson("cipher-check-project");
		await saveVertex(client, account);

		const row = await env.DB.prepare(
			"SELECT ai_provider AS p, api_key_cipher AS c FROM parent_settings WHERE api_key_last4 = 'cipher-check-project'",
		).first<{ p: string; c: string }>();

		expect(row!.p).toBe("vertex");
		expect(row!.c).not.toContain("BEGIN PRIVATE KEY");
		expect(row!.c).not.toContain("service_account");
	});

	it("액세스 토큰은 재사용한다", async () => {
		const { client } = await signupParent();
		// 토큰 인터셉터는 한 번만 건다. 두 번 부르면 disableNetConnect 로 실패한다.
		mockToken(1);
		mockModelList(2);
		mockGenerate(1);

		await saveVertex(client, freshAccount()); // 목록 + 추론 확인
		const models = await client.get("/api/settings/ai/models"); // 목록 재조회

		expect(models.status).toBe(200);
	});
});
