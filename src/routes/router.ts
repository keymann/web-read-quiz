import type { AppEnv, Principal } from "../types";

/**
 * 아주 작은 경로 매처. 프레임워크를 들이지 않기 위해 필요한 만큼만 만든다.
 * 패턴은 `/api/children/:id` 처럼 세그먼트 단위로만 매칭한다.
 */

export interface RouteCtx {
	request: Request;
	env: AppEnv;
	ctx: ExecutionContext;
	url: URL;
	params: Record<string, string>;
	/** 세션에서 복원한 신원. 로그인 전이면 null. */
	principal: Principal | null;
}

export type Handler = (c: RouteCtx) => Promise<Response>;

export interface Route {
	method: string;
	segments: string[];
	handler: Handler;
}

export const route = (method: string, path: string, handler: Handler): Route => ({
	method,
	segments: path.split("/").filter(Boolean),
	handler,
});

export interface Match {
	handler: Handler;
	params: Record<string, string>;
}

export function matchRoute(routes: Route[], method: string, pathname: string): Match | null {
	const parts = pathname.split("/").filter(Boolean);

	for (const r of routes) {
		if (r.method !== method || r.segments.length !== parts.length) continue;

		const params: Record<string, string> = {};
		let matched = true;
		for (let i = 0; i < r.segments.length; i++) {
			const seg = r.segments[i]!;
			if (seg.startsWith(":")) {
				params[seg.slice(1)] = decodeURIComponent(parts[i]!);
			} else if (seg !== parts[i]) {
				matched = false;
				break;
			}
		}
		if (matched) return { handler: r.handler, params };
	}
	return null;
}
