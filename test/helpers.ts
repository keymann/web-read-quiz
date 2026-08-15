import { SELF } from "cloudflare:test";

export const ORIGIN = "http://example.com";

/**
 * 쿠키를 들고 다니는 아주 작은 클라이언트.
 * SELF.fetch 는 쿠키를 자동으로 관리하지 않으므로 Set-Cookie 를 직접 이어 붙인다.
 */
export class Client {
	private cookie: string | null = null;

	constructor(private readonly ip = "10.0.0.1") {}

	async request(
		path: string,
		options: { method?: string; body?: unknown; origin?: string | null } = {},
	): Promise<{ status: number; body: any }> {
		const { method = "GET", body, origin = ORIGIN } = options;

		const headers: Record<string, string> = { "CF-Connecting-IP": this.ip };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		if (origin !== null) headers["Origin"] = origin;
		if (this.cookie) headers["Cookie"] = this.cookie;

		const res = await SELF.fetch(`${ORIGIN}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});

		const setCookie = res.headers.get("Set-Cookie");
		if (setCookie) {
			const pair = setCookie.split(";")[0]!;
			this.cookie = pair.endsWith("=") ? null : pair;
		}

		return { status: res.status, body: await res.json().catch(() => null) };
	}

	get = (path: string) => this.request(path);
	post = (path: string, body?: unknown) => this.request(path, { method: "POST", body });
	patch = (path: string, body?: unknown) => this.request(path, { method: "PATCH", body });
	del = (path: string) => this.request(path, { method: "DELETE" });
}

let counter = 0;
export const uniqueId = (prefix: string): string => `${prefix}${Date.now() % 100000}${counter++}`;

/** 부모 계정을 만들고 로그인된 클라이언트를 돌려준다. */
export async function signupParent(ip?: string): Promise<{ client: Client; loginId: string }> {
	const client = new Client(ip ?? `10.0.0.${(counter % 200) + 1}`);
	const loginId = uniqueId("parent");
	const res = await client.post("/api/auth/signup", {
		loginId,
		password: "password1234",
		password2: "password1234",
		displayName: "부모",
	});
	if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`);
	return { client, loginId };
}

/** 부모 클라이언트로 아이를 추가하고, 그 아이로 로그인한 클라이언트를 함께 돌려준다. */
export async function addChild(
	parent: Client,
	name = "성현",
): Promise<{ childId: string; loginId: string; password: string; client: Client }> {
	const loginId = uniqueId("child");
	const password = "1234";
	const res = await parent.post("/api/children", { name, grade: 5, loginId, password });
	if (res.status !== 201) throw new Error(`addChild failed: ${JSON.stringify(res.body)}`);

	const client = new Client(`10.0.1.${(counter % 200) + 1}`);
	await client.post("/api/auth/login", { loginId, password });

	return { childId: res.body.data.child.id as string, loginId, password, client };
}
