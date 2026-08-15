import { hashPassword, verifyPassword } from "../auth/password";
import { createSession, destroySession, readSession } from "../auth/session";
import { requireAuth } from "../auth/guards";
import * as childrenRepo from "../repositories/children";
import * as usersRepo from "../repositories/users";
import { newId } from "../utils/id";
import { clientIp, rateLimit } from "../utils/ratelimit";
import { conflict, forbidden, invalid, ok, unauthorized } from "../utils/response";
import * as v from "../utils/validate";
import { route, type Route, type RouteCtx } from "./router";

const PARENT_PASSWORD_MIN = 8;

async function signup({ request, env, url }: RouteCtx): Promise<Response> {
	await rateLimit(env, "signup", clientIp(request), 5, 60 * 60);

	const body = await v.readJson(request);
	const id = v.loginId(body);
	const pw = v.password(body, "password", PARENT_PASSWORD_MIN);
	const pw2 = v.password(body, "password2", PARENT_PASSWORD_MIN);
	const name = v.displayName(body, "displayName");

	if (pw !== pw2) throw invalid("비밀번호가 일치하지 않습니다.");

	// 초대 코드는 설정되어 있을 때만 요구한다.
	const expectedInvite = env.INVITE_CODE?.trim();
	if (expectedInvite) {
		if (v.optionalStr(body, "invite") !== expectedInvite) throw forbidden("초대 코드가 올바르지 않습니다.");
	}

	if (await usersRepo.loginIdExists(env, id)) throw conflict("이미 사용 중인 아이디입니다.");

	const userId = newId();
	await usersRepo.insertUser(env, {
		id: userId,
		loginId: id,
		passwordHash: await hashPassword(pw),
		role: "PARENT",
		displayName: name,
	});

	const cookie = await createSession(env, url, { id: userId, role: "PARENT", displayName: name });
	return ok({ role: "PARENT", displayName: name }, 201, { "Set-Cookie": cookie });
}

async function login({ request, env, url }: RouteCtx): Promise<Response> {
	const body = await v.readJson(request);
	const id = v.loginId(body);
	const pw = v.password(body, "password", 1);

	// IP 와 아이디 양쪽으로 건다. 한 아이디를 노리는 공격과 분산 시도를 모두 늦춘다.
	await rateLimit(env, "login-ip", clientIp(request), 30, 15 * 60);
	await rateLimit(env, "login-id", id, 10, 15 * 60);

	const user = await usersRepo.findByLoginId(env, id);
	// 아이디가 없어도 해시 검증에 준하는 시간을 쓰게 해, 존재 여부가 응답 시간으로 새지 않게 한다.
	const stored = user?.password_hash ?? "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
	const valid = await verifyPassword(pw, stored);

	if (!user || !valid) throw unauthorized("아이디 또는 비밀번호가 올바르지 않습니다.");
	if (user.is_active !== 1) throw forbidden("사용할 수 없는 계정입니다.");

	let childId: string | undefined;
	if (user.role === "CHILD") {
		const child = await childrenRepo.findByChildUserId(env, user.id);
		if (!child) throw forbidden("연결된 아이 정보가 없습니다.");
		childId = child.id;
	}

	const cookie = await createSession(env, url, {
		id: user.id,
		role: user.role,
		displayName: user.display_name,
		...(childId ? { childId } : {}),
	});

	return ok({ role: user.role, displayName: user.display_name }, 200, { "Set-Cookie": cookie });
}

async function logout({ request, env, url }: RouteCtx): Promise<Response> {
	const cookie = await destroySession(request, env, url);
	return ok({ loggedOut: true }, 200, { "Set-Cookie": cookie });
}

async function me({ principal }: RouteCtx): Promise<Response> {
	const p = requireAuth(principal);
	return ok({
		role: p.role,
		displayName: p.displayName,
		...(p.childId ? { childId: p.childId } : {}),
	});
}

export const authRoutes: Route[] = [
	route("POST", "/api/auth/signup", signup),
	route("POST", "/api/auth/login", login),
	route("POST", "/api/auth/logout", logout),
	route("GET", "/api/auth/me", me),
];

/** index.ts 가 매 요청마다 신원을 복원할 때 쓴다. */
export { readSession };
