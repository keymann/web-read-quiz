import { requireParent } from "../auth/guards";
import * as settings from "../services/settings";
import { rateLimit } from "../utils/ratelimit";
import { ok } from "../utils/response";
import * as v from "../utils/validate";
import { route, type Route, type RouteCtx } from "./router";

/**
 * 부모 설정. OPENAI_API_KEY 는 여기서만 들어오고, 어떤 응답으로도 나가지 않는다(§21.9).
 * 응답에는 마지막 4자리와 등록 여부만 담는다.
 */

async function read({ env, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	return ok(await settings.getView(env, parent.userId));
}

async function putKey({ request, env, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	// 저장할 때마다 OpenAI 를 호출하므로 남용을 막는다.
	await rateLimit(env, "settings-key", parent.userId, 10, 60 * 60);

	const body = await v.readJson(request);
	const apiKey = v.str(body, "apiKey", "API Key");

	const result = await settings.saveKey(env, parent.userId, apiKey);
	return ok(result);
}

async function deleteKey({ env, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	await settings.clearKey(env, parent.userId);
	return ok({ configured: false });
}

async function models({ env, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	await rateLimit(env, "settings-models", parent.userId, 30, 60 * 60);
	return ok({ models: await settings.listModels(env, parent.userId) });
}

async function putModels({ request, env, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	const body = await v.readJson(request);
	const model = v.str(body, "model", "모델");
	const visionModel = v.optionalStr(body, "visionModel") ?? model;

	await settings.saveModels(env, parent.userId, model, visionModel);
	return ok({ model, visionModel });
}

export const settingsRoutes: Route[] = [
	route("GET", "/api/settings", read),
	route("PUT", "/api/settings/openai-key", putKey),
	route("DELETE", "/api/settings/openai-key", deleteKey),
	route("GET", "/api/settings/openai/models", models),
	route("PUT", "/api/settings/openai/models", putModels),
];
