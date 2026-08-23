/**
 * AI 독서 퀴즈 — Cloudflare Worker 진입점.
 *
 * 하나의 Worker 가 `/api/*` 를 처리하고, 나머지 경로는 `public/` 의 정적 SPA 를 서빙한다.
 * OpenAI 호출은 전부 이 Worker 안에서만 일어나며, API Key 는 클라이언트로 나가지 않는다(§24).
 *
 * 라우트 전체 목록은 docs/api.md 참고.
 */
import { readSession } from "./auth/session";
import { aiRelayRoutes } from "./routes/ai-relay";
import { attemptRoutes } from "./routes/attempts";
import { authRoutes } from "./routes/auth";
import { bookRoutes } from "./routes/books";
import { childrenRoutes } from "./routes/children";
import { historyRoutes } from "./routes/history";
import { quizRoutes } from "./routes/quizzes";
import { statsRoutes } from "./routes/stats";
import { matchRoute, type Route } from "./routes/router";
import { settingsRoutes } from "./routes/settings";
import type { AppEnv } from "./types";
import { assertSameOrigin } from "./utils/csrf";
import { clientIp, rateLimitLocal } from "./utils/ratelimit";
import { fail, toResponse } from "./utils/response";

const routes: Route[] = [
	...authRoutes,
	...childrenRoutes,
	...settingsRoutes,
	...bookRoutes,
	...quizRoutes,
	...attemptRoutes,
	...statsRoutes,
	...historyRoutes,
	...aiRelayRoutes,
];

export default {
	async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// 정적 자산의 보안 헤더(CSP 등)는 자산 서버가 `public/_headers` 로 붙인다.
		// 실제 파일이 있는 경로는 Worker 를 아예 거치지 않으므로 여기서 붙여도 일관성이 없다.
		if (!url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		try {
			return await handleApi(request, env, ctx, url);
		} catch (err) {
			return toResponse(err);
		}
	},
} satisfies ExportedHandler<AppEnv>;

async function handleApi(
	request: Request,
	env: AppEnv,
	ctx: ExecutionContext,
	url: URL,
): Promise<Response> {
	// 상태를 바꾸는 요청은 오리진이 같아야 한다(§26 CSRF).
	assertSameOrigin(request, url);

	const match = matchRoute(routes, request.method, url.pathname);
	if (!match) return fail("not_found", "존재하지 않는 API 입니다.", 404);

	const principal = await readSession(request, env);

	/*
	 * 인증된 사용자는 사용자 단위로, 아니면 IP 단위로 전체 호출량을 제한한다.
	 *
	 * **KV 를 쓰지 않는 쪽으로 센다.** 이 줄은 모든 API 요청을 지나므로 KV 에 쓰면 요청마다
	 * 쓰기 한 번이 된다. 무료 등급은 하루 1,000회라 그것으로 앱 전체가 멈춘 적이 있다
	 * (2026-08-23, `utils/ratelimit.ts` 머리말). 정확히 세야 하는 제한은 각 라우트가
	 * 자기 스코프로 따로 건다.
	 */
	rateLimitLocal("api", principal?.userId ?? clientIp(request), 300, 60);

	// `await` 를 붙여 핸들러의 예외가 이 함수의 프레임 안에서 거부되게 한다.
	// 그냥 반환하면 거부된 프로미스가 채택되기 전 한 틱 동안 미처리 상태로 남아
	// 런타임이 unhandled rejection 으로 보고한다.
	return await match.handler({ request, env, ctx, url, params: match.params, principal });
}
