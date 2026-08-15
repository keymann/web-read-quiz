import { forbidden } from "./response";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF 방어의 두 번째 층.
 *
 * 1층은 세션 쿠키의 `SameSite=Lax` — 크로스 사이트 POST 에는 쿠키가 실리지 않는다.
 * 2층이 이 검사로, 상태를 바꾸는 요청은 `Origin` 이 자기 오리진과 정확히 같아야 한다.
 * 프론트와 API 가 같은 Worker(같은 오리진)이므로 예외를 둘 필요가 없다.
 */
export function assertSameOrigin(request: Request, url: URL): void {
	if (SAFE_METHODS.has(request.method)) return;

	const origin = request.headers.get("Origin");
	if (origin === null || origin !== url.origin) {
		throw forbidden("허용되지 않은 요청 출처입니다.");
	}
}
