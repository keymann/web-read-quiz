/**
 * API 호출 래퍼.
 *
 * 세션은 HttpOnly 쿠키라 JS 가 토큰을 다루지 않는다. `credentials: "same-origin"` 만 붙이면 된다.
 * 서버 응답은 항상 `{ok:true,data}` / `{ok:false,error}` 이므로 여기서 한 번만 풀어준다.
 */

export class ApiError extends Error {
	constructor(code, message, status) {
		super(message);
		this.name = "ApiError";
		this.code = code;
		this.status = status;
	}
}

export async function api(path, { method = "GET", body } = {}) {
	let res;
	try {
		res = await fetch(path, {
			method,
			credentials: "same-origin",
			headers: body === undefined ? {} : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch {
		throw new ApiError("network", "네트워크에 연결할 수 없습니다.", 0);
	}

	let payload = null;
	try {
		payload = await res.json();
	} catch {
		/* 본문이 JSON 이 아닌 경우는 아래에서 일괄 처리 */
	}

	if (payload && payload.ok === true) return payload.data;

	throw new ApiError(
		payload?.error?.code ?? "internal",
		payload?.error?.message ?? "요청을 처리하지 못했습니다.",
		res.status,
	);
}

export const get = (path) => api(path);
export const post = (path, body) => api(path, { method: "POST", body });
export const patch = (path, body) => api(path, { method: "PATCH", body });
export const put = (path, body) => api(path, { method: "PUT", body });
export const del = (path) => api(path, { method: "DELETE" });
