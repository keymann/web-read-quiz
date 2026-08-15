import { requireChild } from "../auth/guards";
import * as attempt from "../services/attempt";
import * as generation from "../services/generation";
import * as retry from "../services/retry";
import { rateLimit } from "../utils/ratelimit";
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

	// 재도전 상태를 함께 준다. 결과 화면이 카운트다운을 그리려면 매번 필요하다.
	const [view, retryState] = await Promise.all([
		attempt.detail(env, child.childId, params.id!),
		retry.state(env, child.childId, params.id!),
	]);

	return ok({ attempt: view, retry: retryState });
}

/**
 * 다시 도전한다(§18) — 같은 책의 새 회차를 만든다.
 *
 * 문제 생성은 부모의 AI 키로 돈다. 서버가 그 제공자를 부를 수 있으면 여기서 백그라운드로
 * 시작하고, Gemini 처럼 부를 수 없으면 부모의 브라우저가 만들어 줘야 한다(`NEEDS_PARENT`).
 */
async function retryQuiz({ env, ctx, principal, params }: RouteCtx): Promise<Response> {
	const child = requireChild(principal);
	// 재도전마다 AI 생성이 다시 돈다. 부모 키로 결제되므로 횟수를 묶어 둔다(§리스크).
	await rateLimit(env, "retry", child.childId, 10, 60 * 60);

	const result = await retry.start(env, child.childId, params.id!);

	if (result.generateQuizId) {
		const quizId = result.generateQuizId;
		const parentUserId = await retry.parentOf(env, quizId);
		ctx.waitUntil(generation.runGeneration(env, parentUserId, quizId));
	}

	return ok({ retry: result.state }, 201);
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
	route("POST", "/api/attempts/:id/retry", retryQuiz),
	route("GET", "/api/my/attempts", history),
];
