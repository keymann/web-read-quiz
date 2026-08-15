import { describe, expect, it } from "vitest";
import { Client, addChild, signupParent, uniqueId } from "./helpers";

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
		});
		expect(res.status).toBe(409);
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
