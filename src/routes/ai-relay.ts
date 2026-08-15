import { requireParent } from "../auth/guards";
import * as relay from "../services/relay";
import { rateLimit } from "../utils/ratelimit";
import { invalid, ok } from "../utils/response";
import * as v from "../utils/validate";
import { route, type Route, type RouteCtx } from "./router";

/**
 * 브라우저 릴레이 라우트(§docs/architecture.md).
 *
 * 부모의 브라우저가 Gemini 를 직접 부르는 경로다. 서버는 요청을 만들어 주고 결과를 판정한다.
 * 브라우저는 자기 키를 붙여 보내고 응답을 그대로 돌려주기만 한다.
 *
 * 모든 라우트가 PARENT 전용이며, 제공자가 gemini 가 아니면 서비스 레이어가 거부한다.
 */

/**
 * 길이를 제한한 배열. 넘치면 거부한다.
 *
 * 잘라서 받아들이면 클라이언트는 자기가 보낸 것이 다 반영된 줄 안다. 서버가 조용히 버리는
 * 것보다 "너무 많다" 고 말해 주는 편이 낫다.
 */
function boundedArray(value: unknown, max: number): never[] {
	if (!Array.isArray(value)) return [];
	if (value.length > max) throw invalid(`한 번에 ${max}개까지만 보낼 수 있습니다.`);
	return value as never[];
}

/** 자격증명은 브라우저에 캐시되지 않는다. 작업마다 다시 받아 가므로 호출이 잦다. */
async function credential({ env, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	await rateLimit(env, "ai-credential", parent.userId, 120, 60 * 60);

	// 응답은 캐시 금지 헤더가 이미 붙는다(utils/response 의 BASE_HEADERS).
	return ok(await relay.credential(env, parent.userId));
}

/** 다음에 보낼 요청을 만들어 준다. */
async function plan({ request, env, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	await rateLimit(env, "ai", parent.userId, 200, 60 * 60);

	const body = await v.readJson(request);
	const kind = v.str(body, "kind", "단계");

	// 브라우저가 "이 모델은 응답하지 않더라" 고 알려준 목록. 다음에 무엇을 쓸지는 서버가 정한다.
	// 서버가 최대 3개까지만 바꾸므로 그 이상은 받을 이유가 없다.
	const avoid = v.strArray(body, "avoid", { max: 8, maxLength: 120 });

	switch (kind) {
		case "identify":
			return ok(await relay.planIdentify(env, parent.userId, v.str(body, "bookId", "책"), avoid));

		case "research":
			return ok(
				await relay.planResearch(
					env,
					parent.userId,
					v.str(body, "bookId", "책"),
					body.webSearch !== false,
					avoid,
				),
			);

		case "generate":
			return ok(
				await relay.planGenerate(
					env,
					parent.userId,
					v.str(body, "quizId", "퀴즈"),
					// 프롬프트에 넣는 것은 최근 10건뿐이다. 그보다 훨씬 넉넉히 잡고 나머지는 막는다.
					boundedArray(body.rejected, 100),
					avoid,
				),
			);

		case "validate":
			return ok(
				await relay.planValidate(
					env,
					parent.userId,
					v.str(body, "quizId", "퀴즈"),
					body.response,
					avoid,
				),
			);

		default:
			throw invalid("알 수 없는 단계입니다.");
	}
}

/** 브라우저가 받아 온 Gemini 원본 응답을 서버가 해석하고 반영한다. */
async function apply({ request, env, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	await rateLimit(env, "ai", parent.userId, 200, 60 * 60);

	const body = await v.readJson(request);
	const kind = v.str(body, "kind", "단계");

	switch (kind) {
		case "identify":
			return ok(
				await relay.applyIdentify(env, parent.userId, v.str(body, "bookId", "책"), body.response),
			);

		case "research":
			return ok(
				await relay.applyResearch(
					env,
					parent.userId,
					v.str(body, "bookId", "책"),
					body.response,
					body.groundingUsed !== false,
				),
			);

		case "accept":
			return ok(
				await relay.applyAccept(
					env,
					parent.userId,
					v.str(body, "quizId", "퀴즈"),
					// 한 라운드에 만들 수 있는 문항 수를 넘길 이유가 없다. 서버가 다시 사후검사도 한다.
					boundedArray(body.questions, 100),
					body.response,
				),
			);

		default:
			throw invalid("알 수 없는 단계입니다.");
	}
}

export const aiRelayRoutes: Route[] = [
	route("GET", "/api/ai/credential", credential),
	route("POST", "/api/ai/plan", plan),
	route("POST", "/api/ai/apply", apply),
];
