import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authRoutes } from "../src/routes/auth";
import { toResponse } from "../src/utils/response";
import { Client, INVITE_CODE, ORIGIN, addChild, signupParent, uniqueId } from "./helpers";

describe("인증", () => {
	it("부모 가입 후 세션이 만들어진다", async () => {
		const { client } = await signupParent();

		const me = await client.get("/api/auth/me");
		expect(me.status).toBe(200);
		expect(me.body.data.role).toBe("PARENT");
	});

	it("비밀번호가 다르면 가입되지 않는다", async () => {
		const client = new Client("10.0.9.1");
		const res = await client.post("/api/auth/signup", {
			loginId: uniqueId("p"),
			password: "password1234",
			password2: "password9999",
			displayName: "부모",
		});
		expect(res.status).toBe(400);
		expect(res.body.error.code).toBe("invalid");
	});

	it("이미 쓰는 아이디로는 가입할 수 없다", async () => {
		const { loginId } = await signupParent();
		const client = new Client("10.0.9.2");
		const res = await client.post("/api/auth/signup", {
			loginId,
			password: "password1234",
			password2: "password1234",
			displayName: "다른부모",
			invite: INVITE_CODE,
		});
		expect(res.status).toBe(409);
	});

	/*
	 * 초대 코드 없이 가입이 열리면 아이 이름·학년과 독서 기록이 아무에게나 쌓인다.
	 * 그래서 "설정돼 있으면 검사" 가 아니라 "늘 검사" 다.
	 */
	it("초대 코드가 맞아야 가입된다", async () => {
		const client = new Client("10.0.9.10");
		const res = await client.post("/api/auth/signup", {
			loginId: uniqueId("p"),
			password: "password1234",
			password2: "password1234",
			displayName: "부모",
			invite: INVITE_CODE,
		});
		expect(res.status).toBe(201);
	});

	it("초대 코드가 틀리면 가입되지 않는다", async () => {
		const client = new Client("10.0.9.11");
		const res = await client.post("/api/auth/signup", {
			loginId: uniqueId("p"),
			password: "password1234",
			password2: "password1234",
			displayName: "부모",
			invite: "wrong-code",
		});
		expect(res.status).toBe(403);
		expect(res.body.error.code).toBe("forbidden");
	});

	it("초대 코드를 아예 안 보내도 가입되지 않는다", async () => {
		const client = new Client("10.0.9.12");
		const res = await client.post("/api/auth/signup", {
			loginId: uniqueId("p"),
			password: "password1234",
			password2: "password1234",
			displayName: "부모",
		});
		expect(res.status).toBe(403);
	});

	// 붙여넣을 때 앞뒤 공백이 묻어 오는 일이 흔하다. 그것 때문에 막지는 않는다.
	it("초대 코드 앞뒤 공백은 무시한다", async () => {
		const client = new Client("10.0.9.13");
		const res = await client.post("/api/auth/signup", {
			loginId: uniqueId("p"),
			password: "password1234",
			password2: "password1234",
			displayName: "부모",
			invite: `  ${INVITE_CODE}\n`,
		});
		expect(res.status).toBe(201);
	});

	/**
	 * 배포에서 시크릿을 빠뜨리면 가입이 **막혀야** 한다. 예전에는 그 경우 검사를 건너뛰어
	 * 가입이 조용히 열렸다 — 열린 것은 알아채지 못하고, 막힌 것은 금방 알아챈다.
	 *
	 * 바인딩은 워커가 뜰 때 정해져 테스트에서 바꿀 수 없다. 그래서 요청을 보내는 대신
	 * 핸들러를 직접 부르고 env 만 갈아 끼운다.
	 */
	it("초대 코드가 설정돼 있지 않으면 가입을 받지 않는다", async () => {
		const signup = authRoutes.find(
			(r) => r.method === "POST" && r.segments.join("/") === "api/auth/signup",
		);
		expect(signup).toBeDefined();

		const url = new URL(`${ORIGIN}/api/auth/signup`);
		const body = {
			loginId: uniqueId("p"),
			password: "password1234",
			password2: "password1234",
			displayName: "부모",
			invite: INVITE_CODE,
		};

		// 핸들러는 ApiError 를 던지고 index.ts 가 응답으로 바꾼다. 여기서도 같은 변환을 거친다.
		const call = async (inviteCode: string) => {
			try {
				return await signup!.handler({
					request: new Request(url, {
						method: "POST",
						headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "10.0.9.14" },
						body: JSON.stringify(body),
					}),
					env: { ...env, INVITE_CODE: inviteCode },
					ctx: createExecutionContext(),
					url,
					params: {},
					principal: null,
				});
			} catch (err) {
				return toResponse(err);
			}
		};

		// 설정이 비어 있으면 올바른 코드를 보내도 막힌다.
		expect((await call("")).status).toBe(403);
		// 같은 요청이 설정만 채워지면 통과한다 — 막힌 이유가 초대 코드 설정 때문임을 못박는다.
		expect((await call(INVITE_CODE)).status).toBe(201);
	});

	it("잘못된 비밀번호로는 로그인할 수 없다", async () => {
		const { loginId } = await signupParent();
		const client = new Client("10.0.9.3");
		const res = await client.post("/api/auth/login", { loginId, password: "wrong-password" });
		expect(res.status).toBe(401);
	});

	it("없는 아이디와 틀린 비밀번호가 같은 응답을 준다", async () => {
		const { loginId } = await signupParent();
		const client = new Client("10.0.9.4");

		const wrongPassword = await client.post("/api/auth/login", { loginId, password: "wrong-password" });
		const noSuchUser = await client.post("/api/auth/login", { loginId: uniqueId("ghost"), password: "wrong-password" });

		expect(wrongPassword.status).toBe(noSuchUser.status);
		expect(wrongPassword.body.error.message).toBe(noSuchUser.body.error.message);
	});

	it("로그아웃하면 세션이 무효가 된다", async () => {
		const { client } = await signupParent();
		expect((await client.get("/api/auth/me")).status).toBe(200);

		await client.post("/api/auth/logout");
		expect((await client.get("/api/auth/me")).status).toBe(401);
	});

	it("로그인하지 않으면 401", async () => {
		const client = new Client("10.0.9.5");
		expect((await client.get("/api/auth/me")).status).toBe(401);
	});

	// 세션 토큰은 유효한데 사용자 행이 사라진 경우. 그대로 두면 뒤쪽 쿼리가 외래키 오류로 500 을 낸다.
	it("사용자 행이 사라진 세션은 401 로 처리된다", async () => {
		const { client, loginId } = await signupParent();
		expect((await client.get("/api/auth/me")).status).toBe(200);

		await env.DB.prepare("DELETE FROM users WHERE login_id = ?").bind(loginId).run();

		expect((await client.get("/api/auth/me")).status).toBe(401);
	});

	it("아이 계정으로 로그인하면 childId 가 함께 온다", async () => {
		const { client: parent } = await signupParent();
		const { childId, client: child } = await addChild(parent);

		const me = await child.get("/api/auth/me");
		expect(me.status).toBe(200);
		expect(me.body.data.role).toBe("CHILD");
		expect(me.body.data.childId).toBe(childId);
	});
});

describe("CSRF", () => {
	it("Origin 이 없는 변경 요청은 거부된다", async () => {
		const client = new Client("10.0.9.6");
		const res = await client.request("/api/auth/login", {
			method: "POST",
			body: { loginId: "someone", password: "x" },
			origin: null,
		});
		expect(res.status).toBe(403);
	});

	it("다른 오리진에서 온 변경 요청은 거부된다", async () => {
		const client = new Client("10.0.9.7");
		const res = await client.request("/api/auth/login", {
			method: "POST",
			body: { loginId: "someone", password: "x" },
			origin: "https://evil.example",
		});
		expect(res.status).toBe(403);
	});

	it("조회 요청에는 Origin 이 필요 없다", async () => {
		const { client } = await signupParent();
		const res = await client.request("/api/auth/me", { origin: null });
		expect(res.status).toBe(200);
	});
});
