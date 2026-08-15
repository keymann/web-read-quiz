import { requireParent } from "../auth/guards";
import * as stats from "../services/stats";
import { ok } from "../utils/response";
import { route, type Route, type RouteCtx } from "./router";

/**
 * 대시보드(§19).
 *
 * 전부 PARENT 전용이다. 아이는 자기 기록을 `/api/my/attempts` 로 본다 — 아이에게 형제의
 * 점수를 보여줄 이유가 없다.
 */

async function dashboard({ env, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	return ok(await stats.dashboard(env, parent.userId));
}

async function childSummary({ env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	return ok(await stats.childSummary(env, parent.userId, params.id!));
}

async function bookHistory({ env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	return ok({ attempts: await stats.bookHistory(env, parent.userId, params.id!) });
}

export const statsRoutes: Route[] = [
	route("GET", "/api/dashboard", dashboard),
	route("GET", "/api/children/:id/summary", childSummary),
	route("GET", "/api/books/:id/history", bookHistory),
];
