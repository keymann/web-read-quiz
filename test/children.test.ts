import { describe, expect, it } from "vitest";
import { Client, addChild, signupParent, uniqueId } from "./helpers";

describe("아이 관리", () => {
	it("아이를 추가하면 목록에 나타난다", async () => {
		const { client: parent } = await signupParent();
		await addChild(parent, "성현");

		const res = await parent.get("/api/children");
		expect(res.status).toBe(200);
		expect(res.body.data.children).toHaveLength(1);
		expect(res.body.data.children[0].name).toBe("성현");
		expect(res.body.data.children[0].grade).toBe(5);
	});

	it("아이 정보를 수정할 수 있다", async () => {
		const { client: parent } = await signupParent();
		const { childId } = await addChild(parent);

		const res = await parent.patch(`/api/children/${childId}`, { name: "지호", grade: 6 });
		expect(res.status).toBe(200);
		expect(res.body.data.child.name).toBe("지호");
		expect(res.body.data.child.grade).toBe(6);
	});

	it("비밀번호를 바꾸면 새 비밀번호로만 로그인된다", async () => {
		const { client: parent } = await signupParent();
		const { childId, loginId, password } = await addChild(parent);

		await parent.patch(`/api/children/${childId}`, { password: "5678" });

		const client = new Client("10.0.5.1");
		expect((await client.post("/api/auth/login", { loginId, password })).status).toBe(401);
		expect((await client.post("/api/auth/login", { loginId, password: "5678" })).status).toBe(200);
	});

	it("삭제하면 목록에서 사라지고 로그인도 막힌다", async () => {
		const { client: parent } = await signupParent();
		const { childId, loginId, password } = await addChild(parent);

		expect((await parent.del(`/api/children/${childId}`)).status).toBe(200);
		expect((await parent.get("/api/children")).body.data.children).toHaveLength(0);

		const client = new Client("10.0.5.2");
		expect((await client.post("/api/auth/login", { loginId, password })).status).toBe(403);
	});

	it("학년은 1~6 만 받는다", async () => {
		const { client: parent } = await signupParent();
		const res = await parent.post("/api/children", {
			name: "성현",
			grade: 9,
			loginId: uniqueId("c"),
			password: "1234",
		});
		expect(res.status).toBe(400);
	});

	it("아이 비밀번호가 너무 짧으면 거부된다", async () => {
		const { client: parent } = await signupParent();
		const res = await parent.post("/api/children", {
			name: "성현",
			grade: 5,
			loginId: uniqueId("c"),
			password: "12",
		});
		expect(res.status).toBe(400);
	});
});

describe("권한 격리", () => {
	it("다른 부모의 아이는 조회·수정·삭제할 수 없다", async () => {
		const { client: parentA } = await signupParent();
		const { childId } = await addChild(parentA);

		const { client: parentB } = await signupParent();

		expect((await parentB.patch(`/api/children/${childId}`, { name: "탈취" })).status).toBe(404);
		expect((await parentB.del(`/api/children/${childId}`)).status).toBe(404);

		// 원래 이름이 그대로인지 확인
		expect((await parentA.get("/api/children")).body.data.children[0].name).toBe("성현");
	});

	it("다른 부모의 목록에는 내 아이가 보이지 않는다", async () => {
		const { client: parentA } = await signupParent();
		await addChild(parentA);

		const { client: parentB } = await signupParent();
		expect((await parentB.get("/api/children")).body.data.children).toHaveLength(0);
	});

	it("아이 계정은 부모 전용 API 를 쓸 수 없다", async () => {
		const { client: parent } = await signupParent();
		const { client: child } = await addChild(parent);

		expect((await child.get("/api/children")).status).toBe(403);
		expect((await child.post("/api/children", { name: "x", loginId: uniqueId("c"), password: "1234" })).status).toBe(403);
	});

	it("로그인하지 않으면 아이 API 는 401", async () => {
		const client = new Client("10.0.6.1");
		expect((await client.get("/api/children")).status).toBe(401);
	});
});
