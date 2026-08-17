import { SELF, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { attemptRoutes } from "../src/routes/attempts";
import { authRoutes } from "../src/routes/auth";
import { bookRoutes } from "../src/routes/books";
import { childrenRoutes } from "../src/routes/children";
import { historyRoutes } from "../src/routes/history";
import { quizRoutes } from "../src/routes/quizzes";
import { settingsRoutes } from "../src/routes/settings";
import { statsRoutes } from "../src/routes/stats";
import { aiRelayRoutes } from "../src/routes/ai-relay";
import { diagRoutes } from "../src/routes/diag";
import { ORIGIN, addChild, signupParent } from "./helpers";

/**
 * 보안 경계(§21·§26).
 *
 * 개별 기능의 권한 검사는 각 기능 테스트에 있다. 여기서는 **기능이 늘어나도 유지되어야 하는
 * 성질**을 본다 — 새 라우트가 가드를 빼먹지 않았는지, 입력 길이가 열려 있지 않은지,
 * 비밀이 응답에 새지 않는지.
 */

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

/** 로그인 없이 부를 수 있어야 하는 것들. 이 목록에 없으면 인증을 요구해야 한다. */
const PUBLIC_ROUTES = new Set([
	"POST /api/auth/signup",
	"POST /api/auth/login",
	"POST /api/auth/logout",
	"GET /api/auth/me",
]);

const ALL_ROUTES = [
	...authRoutes,
	...childrenRoutes,
	...settingsRoutes,
	...bookRoutes,
	...quizRoutes,
	...attemptRoutes,
	...statsRoutes,
	...historyRoutes,
	...aiRelayRoutes,
	...diagRoutes,
];

/** 라우트는 세그먼트로만 보관된다. 사람이 읽을 경로로 되돌린다. */
const pathOf = (route: { segments: string[] }) => `/${route.segments.join("/")}`;

/** `:id` 를 아무 값으로 채운다. 인증 실패가 먼저 나므로 존재하지 않아도 된다. */
const fillParams = (path: string) => path.replace(/:\w+/g, "00000000-0000-4000-8000-000000000000");

describe("가드 누락 방지", () => {
	/**
	 * 새 라우트를 추가하면서 `requireParent`/`requireChild` 를 빠뜨리는 실수를 잡는다.
	 *
	 * 코드를 읽어 확인하는 대신 **실제로 로그인 없이 불러 본다.** 가드가 없으면 200 이 나오고
	 * 이 테스트가 깨진다.
	 */
	// 라우트가 40개를 넘어 하나씩 부르면 기본 제한시간에 걸린다. 서로 독립적이라 한꺼번에 부른다.
	it("공개 라우트가 아니면 로그인 없이 부를 수 없다", { timeout: 30_000 }, async () => {
		const targets = ALL_ROUTES.map((route) => ({
			route,
			key: `${route.method} ${pathOf(route)}`,
		})).filter(({ key }) => !PUBLIC_ROUTES.has(key));

		const results = await Promise.all(
			targets.map(async ({ route, key }) => {
				const res = await SELF.fetch(`${ORIGIN}${fillParams(pathOf(route))}`, {
					method: route.method,
					headers: {
						Origin: ORIGIN,
						"Content-Type": "application/json",
						"CF-Connecting-IP": "10.9.9.9",
					},
					body: route.method === "GET" ? undefined : "{}",
				});
				return { key, status: res.status };
			}),
		);

		// 401(로그인 필요) 또는 403(역할 불일치)이어야 한다.
		const leaked = results
			.filter(({ status }) => ![401, 403].includes(status))
			.map(({ key, status }) => `${key} → ${status}`);

		expect(leaked).toEqual([]);
		// 실제로 다 불러 봤는지 — 목록이 비면 위 단언이 공허하게 통과한다
		expect(results.length).toBeGreaterThan(30);
	});

	// 라우트를 추가하고 이 목록을 갱신하지 않으면 위 검사가 무의미해진다.
	it("공개 라우트 목록이 실제 라우트와 맞는다", () => {
		const paths = new Set(ALL_ROUTES.map((r) => `${r.method} ${pathOf(r)}`));
		for (const key of PUBLIC_ROUTES) expect(paths.has(key)).toBe(true);
	});
});

describe("CSRF", () => {
	it("Origin 이 다르면 상태를 바꾸는 요청을 거부한다", async () => {
		const { client } = await signupParent();

		// 헬퍼로는 오리진을 바꿀 수 없으므로 직접 부른다.
		const res = await client.request("/api/children", {
			method: "POST",
			body: { name: "성현", grade: 5, loginId: "csrf아이", password: "1234" },
			origin: "https://evil.example.com",
		});

		expect(res.status).toBe(403);
	});

	it("Origin 이 아예 없어도 거부한다", async () => {
		const { client } = await signupParent();

		const res = await client.request("/api/children", {
			method: "POST",
			body: { name: "성현", grade: 5, loginId: "csrf아이2", password: "1234" },
			origin: null,
		});

		expect(res.status).toBe(403);
	});

	// 조회는 막지 않는다. 막으면 외부 링크로 들어온 첫 요청이 실패한다.
	it("조회는 Origin 이 없어도 통과한다", async () => {
		const { client } = await signupParent();
		expect((await client.request("/api/settings", { origin: null })).status).toBe(200);
	});
});

describe("입력 길이", () => {
	it("거대한 JSON 본문은 읽기 전에 거부한다", async () => {
		const { client } = await signupParent();

		// 1MB 상한을 넘긴다
		const res = await client.request("/api/settings/quiz", {
			method: "PUT",
			body: { questionCount: 5, passCount: 3, filler: "가".repeat(1_100_000) },
		});

		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("너무 큽니다");
	});

	// 개수를 막지 않으면 IN (?, ?, …) 이 거대해지고, 목록을 통째로 D1 에 밀어 넣게 된다.
	it("모델 목록은 개수와 길이가 제한된다", async () => {
		const { client } = await signupParent();

		const tooMany = await client.request("/api/settings/ai-key", {
			method: "PUT",
			body: {
				provider: "gemini",
				apiKey: "AIzaSyTestKey0123456789abcdefghijklmno",
				models: Array.from({ length: 500 }, (_, i) => `gemini-3.5-flash-${i}`),
			},
		});
		expect(tooMany.status).toBe(400);

		const tooLong = await client.request("/api/settings/ai-key", {
			method: "PUT",
			body: {
				provider: "gemini",
				apiKey: "AIzaSyTestKey0123456789abcdefghijklmno",
				models: ["gemini-" + "x".repeat(500)],
			},
		});
		expect(tooLong.status).toBe(400);

		// 등록되지 않았다
		expect((await client.get("/api/settings")).body.data.ai.configured).toBe(false);
	});
});

describe("계정 수 제한", () => {
	// 아이를 추가할 때마다 로그인 계정이 하나 생긴다. 막지 않으면 계정을 무한히 찍어낼 수 있다.
	it("아이는 20명까지만 등록된다", { timeout: 30_000 }, async () => {
		const { client } = await signupParent();

		// 20명을 채운다
		for (let i = 0; i < 20; i++) {
			const res = await client.post("/api/children", {
				name: `아이${i}`,
				grade: 3,
				loginId: `한도아이${Date.now()}${i}`,
				password: "1234",
			});
			expect(res.status).toBe(201);
		}

		const over = await client.post("/api/children", {
			name: "스물한번째",
			grade: 3,
			loginId: `한도초과${Date.now()}`,
			password: "1234",
		});

		expect(over.status).toBe(409);
		expect(over.body.error.message).toContain("20명");
	});
});

describe("비밀 노출", () => {
	it("설정 응답에는 키 원문도 해시도 담기지 않는다", async () => {
		const { client } = await signupParent();

		fetchMock
			.get("https://api.openai.com")
			.intercept({ path: "/v1/models", method: "GET" })
			.reply(200, { data: [{ id: "gpt-5.6-mini" }] });
		fetchMock
			.get("https://api.openai.com")
			.intercept({ path: "/v1/responses", method: "POST" })
			.reply(200, { status: "completed", output: [] });

		const key = "sk-secret1234567890abcdefghijk";
		await client.request("/api/settings/ai-key", {
			method: "PUT",
			body: { provider: "openai", apiKey: key },
		});

		const raw = JSON.stringify((await client.get("/api/settings")).body);
		expect(raw).not.toContain(key);
		// 뒤 4자리 힌트만 남는다
		expect(raw).toContain("hijk");
	});

	it("로그인 응답에 비밀번호 해시가 담기지 않는다", async () => {
		const { client, loginId } = await signupParent();
		const password = "password1234";
		const res = await client.post("/api/auth/login", { loginId, password });

		const raw = JSON.stringify(res.body);
		expect(raw).not.toContain(password);
		expect(raw).not.toContain("passwordHash");
		expect(raw).not.toContain("password_hash");
	});

	// 아이디가 있는지 없는지를 응답으로 알 수 있으면 계정을 훑어볼 수 있다.
	it("없는 아이디와 틀린 비밀번호를 구분하지 않는다", async () => {
		const { client, loginId } = await signupParent();

		const wrongId = await client.post("/api/auth/login", {
			loginId: "없는아이디입니다",
			password: "whatever-1234",
		});
		const wrongPw = await client.post("/api/auth/login", {
			loginId,
			password: "wrong-password-1234",
		});

		expect(wrongId.status).toBe(wrongPw.status);
		expect(wrongId.body.error.message).toBe(wrongPw.body.error.message);
	});
});

describe("세션 쿠키", () => {
	it("HttpOnly · SameSite=Lax · Path=/ 로 내려온다", async () => {
		const loginId = `쿠키확인${Date.now()}`;

		const res = await SELF.fetch(`${ORIGIN}/api/auth/signup`, {
			method: "POST",
			headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "10.5.5.5" },
			body: JSON.stringify({
				loginId,
				password: "cookie-check-1234",
				password2: "cookie-check-1234",
				displayName: "쿠키확인",
			}),
		});

		const cookie = res.headers.get("Set-Cookie") ?? "";
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Path=/");
	});

	// 세션을 지우면 그 쿠키로는 더 이상 아무것도 못 한다.
	it("로그아웃하면 그 쿠키는 죽는다", async () => {
		const { client } = await signupParent();
		expect((await client.get("/api/settings")).status).toBe(200);

		await client.post("/api/auth/logout");
		expect((await client.get("/api/settings")).status).toBe(401);
	});

	/**
	 * 부모가 아이를 삭제하면 그 아이가 이미 들고 있던 로그인도 즉시 끊겨야 한다.
	 * 매 요청마다 사용자 행의 활성 여부를 확인하기 때문에 성립한다.
	 */
	it("삭제된 아이의 세션은 그 즉시 끊긴다", async () => {
		const { client: parent } = await signupParent();
		const child = await addChild(parent, "성현");

		expect((await child.client.get("/api/my/quizzes")).status).toBe(200);
		await parent.del(`/api/children/${child.childId}`);
		expect((await child.client.get("/api/my/quizzes")).status).toBe(401);
	});
});

/**
 * 참고 자료의 URL 은 **AI 응답과 외부 서지 API** 에서 온다. 우리가 만든 값이 아니다.
 * `javascript:` 가 섞여 들어오면 부모 화면에 그대로 링크로 붙는다.
 */
describe("AI 가 준 URL", () => {
	it("http(s) 가 아닌 출처 주소는 저장하지 않는다", async () => {
		const { client } = await signupParent();

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
			body: { provider: "openai", apiKey: "sk-test1234567890abcdefghijklmn" },
		});

		const PNG = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
			0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
			0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
			0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
			0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
		]);
		const form = new FormData();
		form.append("cover", new File([PNG], "cover.png", { type: "image/png" }));
		const bookId = (await client.upload("/api/books", form)).body.data.book.id;
		await client.patch(`/api/books/${bookId}`, { title: "마당을 나온 암탉", author: "황선미" });

		fetchMock
			.get("https://www.googleapis.com")
			.intercept({ path: (p) => p.startsWith("/books/v1/volumes"), method: "GET" })
			.reply(200, {});
		fetchMock
			.get("https://api.openai.com")
			.intercept({ path: "/v1/responses", method: "POST" })
			.reply(200, {
				status: "completed",
				output: [
					{
						type: "message",
						content: [
							{
								type: "output_text",
								text: JSON.stringify({
									title: "마당을 나온 암탉",
									author: "황선미",
									publisher: "사계절",
									isbn13: "",
									publishedAt: "2000",
									targetAge: "초등 고학년",
									description: "이야기.",
									plotSummary: "잎싹이 양계장을 나온다.",
									characters: [{ name: "잎싹", role: "암탉" }],
									keyEvents: ["떠난다"],
									sources: [
										{ url: "javascript:alert(1)", title: "나쁜 링크", content: "가" },
										{ url: "data:text/html,<script>alert(1)</script>", title: "나쁜 링크2", content: "나" },
										{ url: "https://example.com/good", title: "멀쩡한 링크", content: "다" },
									],
								}),
							},
						],
					},
				],
			});
		await client.post(`/api/books/${bookId}/search`);

		const { sources } = (await client.get(`/api/books/${bookId}`)).body.data;
		const urls = sources.map((s: { url: string | null }) => s.url);

		expect(urls).toContain("https://example.com/good");
		for (const url of urls) {
			if (url !== null) expect(url).toMatch(/^https?:\/\//);
		}
	});
});

describe("업로드", () => {
	const upload = async (client: Awaited<ReturnType<typeof signupParent>>["client"], bytes: Uint8Array) => {
		const form = new FormData();
		form.append("cover", new File([bytes], "cover.png", { type: "image/png" }));
		return client.upload("/api/books", form);
	};

	// Content-Type 은 클라이언트가 마음대로 적는다. 바이트를 봐야 한다.
	it("이미지가 아닌 바이트는 확장자·MIME 을 속여도 거부한다", async () => {
		const { client } = await signupParent();
		const notAnImage = new TextEncoder().encode("<script>alert(1)</script>");

		const res = await upload(client, notAnImage);
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("이미지만");
	});

	it("빈 파일은 거부한다", async () => {
		const { client } = await signupParent();
		expect((await upload(client, new Uint8Array(0))).status).toBe(400);
	});
});
