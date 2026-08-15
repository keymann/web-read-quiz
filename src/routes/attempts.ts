import { requireChild } from "../auth/guards";
import * as attempt from "../services/attempt";
import { ok } from "../utils/response";
import * as v from "../utils/validate";
import { route, type Route, type RouteCtx } from "./router";

/**
 * 아이가 퀴즈를 푸는 경로(§15).
 *
 * 전부 CHILD 전용이고, 서비스가 다시 한 번 `child_id` 를 확인한다. 라우트 가드를 빠뜨려도
 * 남의 판이 열리지 않게 하는 두 번째 방어선이다(§21.5).
 */

/** 배정을 받아 판을 연다. 이미 풀던 판이 있으면 그것을 이어 준다. */
async function start({ request, env, principal }: RouteCtx): Promise<Response> {
	const child = requireChild(principal);
	const body = await v.readJson(request);
	const assignmentId = v.str(body, "assignmentId", "퀴즈");

	return ok({ attempt: await attempt.start(env, child.childId, assignmentId) }, 201);
}

async function detail({ env, principal, params }: RouteCtx): Promise<Response> {
	const child = requireChild(principal);
	return ok({ attempt: await attempt.detail(env, child.childId, params.id!) });
}

/** 한 문제에 답한다. 채점은 서버가 한다 — 클라이언트가 보낸 정답은 쓰지 않는다. */
async function answer({ request, env, principal, params }: RouteCtx): Promise<Response> {
	const child = requireChild(principal);
	const body = await v.readJson(request);

	return ok(
		await attempt.answer(
			env,
			child.childId,
			params.id!,
			Number(body.questionNumber),
			Number(body.selectedChoice),
		),
	);
}

/** 남은 문항을 두고 그만둔다. 지금까지의 결과로 확정한다. */
async function submit({ env, principal, params }: RouteCtx): Promise<Response> {
	const child = requireChild(principal);
	return ok({ attempt: await attempt.submit(env, child.childId, params.id!) });
}

async function history({ env, principal }: RouteCtx): Promise<Response> {
	const child = requireChild(principal);
	return ok({ attempts: await attempt.history(env, child.childId) });
}

export const attemptRoutes: Route[] = [
	route("POST", "/api/attempts", start),
	route("GET", "/api/attempts/:id", detail),
	route("POST", "/api/attempts/:id/answers", answer),
	route("POST", "/api/attempts/:id/submit", submit),
	route("GET", "/api/my/attempts", history),
];
