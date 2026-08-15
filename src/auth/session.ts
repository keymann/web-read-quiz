import type { AppEnv, Principal, Role } from "../types";
import { fromBase64Url, timingSafeEqual, toBase64Url, utf8 } from "../utils/base64";
import { newId } from "../utils/id";

/**
 * 세션 — HS256 서명 토큰 + KV 세션 레코드.
 *
 * 토큰만으로도 신원을 복원할 수 있지만, 로그아웃/강제 만료를 위해 `jti` 를 KV 에 두고
 * 매 요청마다 존재를 확인한다. KV 에서 지우면 그 즉시 무효가 된다.
 *
 * 쿠키는 HTTPS 에서 `__Host-` 프리픽스를 쓴다. 이 프리픽스는 `Secure` 를 요구하므로
 * 로컬 http 개발에서는 붙일 수 없어 이름을 나눈다. 읽을 때는 둘 다 확인한다.
 */
const TTL_SECONDS = 60 * 60 * 24 * 14; // 14일
const SECURE_COOKIE = "__Host-session";
const DEV_COOKIE = "session";

interface Claims {
	sub: string;
	role: Role;
	name: string;
	/** role === "CHILD" 일 때만 존재. */
	cid?: string;
	jti: string;
	iat: number;
	exp: number;
}

const signingKey = (secret: string): Promise<CryptoKey> =>
	crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
		"verify",
	]);

async function sign(payload: Claims, secret: string): Promise<string> {
	const header = toBase64Url(utf8(JSON.stringify({ alg: "HS256", typ: "JWT" })));
	const body = toBase64Url(utf8(JSON.stringify(payload)));
	const data = `${header}.${body}`;
	const sig = await crypto.subtle.sign("HMAC", await signingKey(secret), utf8(data));
	return `${data}.${toBase64Url(new Uint8Array(sig))}`;
}

async function verify(token: string, secret: string): Promise<Claims | null> {
	const parts = token.split(".");
	if (parts.length !== 3) return null;

	const expected = await crypto.subtle.sign(
		"HMAC",
		await signingKey(secret),
		utf8(`${parts[0]}.${parts[1]}`),
	);
	if (!timingSafeEqual(new Uint8Array(expected), fromBase64Url(parts[2]!))) return null;

	try {
		const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]!))) as Claims;
		if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
		return claims;
	} catch {
		return null;
	}
}

/* ── 쿠키 ─────────────────────────────────────────────── */

const cookieName = (url: URL): string =>
	url.protocol === "https:" ? SECURE_COOKIE : DEV_COOKIE;

function readCookie(request: Request): string | null {
	const header = request.headers.get("Cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx === -1) continue;
		const name = part.slice(0, idx).trim();
		if (name === SECURE_COOKIE || name === DEV_COOKIE) return part.slice(idx + 1).trim();
	}
	return null;
}

function buildCookie(url: URL, value: string, maxAge: number): string {
	const secure = url.protocol === "https:" ? "; Secure" : "";
	return `${cookieName(url)}=${value}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/* ── 공개 API ─────────────────────────────────────────── */

export interface SessionUser {
	id: string;
	role: Role;
	displayName: string;
	childId?: string;
}

/** 로그인 성공 시 호출. 반환값을 `Set-Cookie` 헤더로 내려보낸다. */
export async function createSession(
	env: AppEnv,
	url: URL,
	user: SessionUser,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const claims: Claims = {
		sub: user.id,
		role: user.role,
		name: user.displayName,
		...(user.childId ? { cid: user.childId } : {}),
		jti: newId(),
		iat: now,
		exp: now + TTL_SECONDS,
	};

	await env.SESSIONS.put(`session:${claims.jti}`, user.id, { expirationTtl: TTL_SECONDS });
	return buildCookie(url, await sign(claims, env.SESSION_SECRET), TTL_SECONDS);
}

/** 요청에서 신원을 복원한다. 실패하면 null — 여기서 예외를 던지지 않는다. */
export async function readSession(
	request: Request,
	env: AppEnv,
): Promise<Principal | null> {
	const token = readCookie(request);
	if (!token) return null;

	const claims = await verify(token, env.SESSION_SECRET);
	if (!claims) return null;

	// KV 레코드가 사라졌으면 로그아웃되었거나 만료된 세션이다.
	if ((await env.SESSIONS.get(`session:${claims.jti}`)) === null) return null;

	return {
		userId: claims.sub,
		role: claims.role,
		displayName: claims.name,
		...(claims.cid ? { childId: claims.cid } : {}),
	};
}

/** 로그아웃. KV 레코드를 지우고 만료된 쿠키를 돌려준다. */
export async function destroySession(request: Request, env: AppEnv, url: URL): Promise<string> {
	const token = readCookie(request);
	if (token) {
		const claims = await verify(token, env.SESSION_SECRET);
		if (claims) await env.SESSIONS.delete(`session:${claims.jti}`);
	}
	return buildCookie(url, "", 0);
}
