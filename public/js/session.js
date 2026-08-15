import { get, post } from "./api.js";
import { navigate } from "./router.js";

/**
 * 현재 로그인 상태를 앱 전역에서 한 번만 조회해 들고 있는다.
 * 여기 담긴 role 은 화면 분기용일 뿐이고, 실제 권한 판단은 항상 서버가 한다.
 */

let current = null;
let loaded = false;

export async function loadSession({ force = false } = {}) {
	if (loaded && !force) return current;
	try {
		current = await get("/api/auth/me");
	} catch {
		current = null;
	}
	loaded = true;
	return current;
}

export const session = () => current;

export function setSession(value) {
	current = value;
	loaded = true;
}

export async function logout() {
	await post("/api/auth/logout");
	current = null;
	await navigate("/login", { replace: true });
}

/** 로그인 상태가 아니면 로그인 화면으로 보낸다. */
export async function requireSession(role) {
	const s = await loadSession();
	if (!s) {
		await navigate("/login", { replace: true });
		return null;
	}
	if (role && s.role !== role) {
		await navigate(s.role === "PARENT" ? "/parent" : "/child", { replace: true });
		return null;
	}
	return s;
}

/** 로그인 직후 role 에 맞는 홈으로. */
export const homePathFor = (role) => (role === "PARENT" ? "/parent" : "/child");
