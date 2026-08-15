import { isProviderName } from "../ai/types";
import { requireParent } from "../auth/guards";
import * as settings from "../services/settings";
import { rateLimit } from "../utils/ratelimit";
import { invalid, ok } from "../utils/response";
import * as v from "../utils/validate";
import { route, type Route, type RouteCtx } from "./router";

/**
 * 부모 설정. API Key 는 여기서만 들어오고, 어떤 응답으로도 나가지 않는다(§21.9).
 * 응답에는 마지막 4자리와 등록 여부만 담는다.
 */

async function read({ env, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	return ok(await settings.getView(env, parent.userId));
}

async function putKey({ request, env, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	// 저장할 때마다 제공자를 호출하므로 남용을 막는다.
	await rateLimit(env, "settings-key", parent.userId, 10, 60 * 60);

	const body = await v.readJson(request);
	const provider = v.str(body, "provider", "AI 제공자");
	if (!isProviderName(provider)) throw invalid("지원하지 않는 AI 제공자입니다.");

	const apiKey = v.str(body, "apiKey", "API Key");
	// Gemini 는 서버가 부를 수 없어 브라우저가 조회한 모델 목록을 함께 보낸다.
	// 실제 계정 목록이 50건 안팎이라 200이면 넉넉하다.
	const models = "models" in body ? v.strArray(body, "models", { max: 200, maxLength: 120 }) : undefined;

	return ok(await settings.saveKey(env, parent.userId, provider, apiKey, models));
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

/** 한 번에 출제할 문제 개수·통과 개수·문제 언어(§17·§21.1). 기본값은 20/10/영어. */
async function putQuizSettings({ request, env, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	const body = await v.readJson(request);

	const questionCount = Number(body.questionCount);
	const passCount = Number(body.passCount);
	// 언어를 안 보내면 지금 값을 유지한다. 문항 수만 고치러 온 요청이 언어를 되돌리면 안 된다.
	const current = await settings.getQuizSettings(env, parent.userId);
	const language = body.questionLanguage === undefined
		? current.questionLanguage
		: String(body.questionLanguage);

	return ok(
		await settings.saveQuizSettings(env, parent.userId, questionCount, passCount, language as never),
	);
}

export const settingsRoutes: Route[] = [
	route("GET", "/api/settings", read),
	route("PUT", "/api/settings/ai-key", putKey),
	route("DELETE", "/api/settings/ai-key", deleteKey),
	route("GET", "/api/settings/ai/models", models),
	route("PUT", "/api/settings/ai/models", putModels),
	route("PUT", "/api/settings/quiz", putQuizSettings),
];
