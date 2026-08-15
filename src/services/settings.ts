import { listUsableModels, pickDefault, verifyKey } from "../ai/models";
import * as settingsRepo from "../repositories/settings";
import type { AppEnv } from "../types";
import { seal, unseal } from "../utils/crypto";
import { ApiError, invalid } from "../utils/response";

/**
 * 부모 설정 — OPENAI_API_KEY 보관과 모델 선택.
 *
 * 이 모듈 밖으로 **복호화된 키가 나가는 경로는 `getApiKey` 하나뿐**이고, 그 반환값은
 * AI 서비스가 OpenAI 를 호출할 때만 쓴다. 라우트가 응답에 담을 일이 없도록 분리했다.
 */

/** 클라이언트에 내보내는 설정. 키 원문은 절대 포함하지 않는다(§21.9). */
export interface SettingsView {
	openai: {
		configured: boolean;
		last4: string | null;
		model: string | null;
		visionModel: string | null;
	};
}

export async function getView(env: AppEnv, userId: string): Promise<SettingsView> {
	const row = await settingsRepo.find(env, userId);
	return {
		openai: {
			configured: row?.openai_api_key_cipher !== null && row?.openai_api_key_cipher !== undefined,
			last4: row?.openai_api_key_last4 ?? null,
			model: row?.openai_model ?? null,
			visionModel: row?.openai_vision_model ?? null,
		},
	};
}

export interface SaveKeyResult {
	last4: string;
	models: string[];
	model: string | null;
}

/**
 * 키를 저장하기 전에 OpenAI 에 한 번 물어본다.
 * 잘못된 키가 저장되면 그 사실을 문제 생성 단계에서야 알게 되어 진단이 어렵다.
 */
export async function saveKey(env: AppEnv, userId: string, apiKey: string): Promise<SaveKeyResult> {
	const trimmed = apiKey.trim();
	if (!trimmed.startsWith("sk-")) {
		throw invalid("OpenAI API Key 는 sk- 로 시작합니다. 값을 다시 확인해 주세요.");
	}
	if (trimmed.length < 20 || trimmed.length > 300) throw invalid("API Key 형식이 올바르지 않습니다.");

	const models = await verifyKey(trimmed);
	if (models.length === 0) {
		throw invalid("이 키로 사용할 수 있는 모델이 없습니다. OpenAI 결제 설정을 확인해 주세요.");
	}

	const sealed = await seal(env, trimmed);
	const last4 = trimmed.slice(-4);
	await settingsRepo.saveKey(env, userId, { ...sealed, last4 });

	// 아직 고른 모델이 없으면 선호 순서의 첫 모델을 기본으로 잡아 준다.
	const existing = await settingsRepo.find(env, userId);
	let model = existing?.openai_model ?? null;
	if (model === null || !models.includes(model)) {
		model = pickDefault(models);
		await settingsRepo.saveModels(env, userId, { model, visionModel: model });
	}

	return { last4, models, model };
}

export async function clearKey(env: AppEnv, userId: string): Promise<void> {
	await settingsRepo.clearKey(env, userId);
}

export async function listModels(env: AppEnv, userId: string): Promise<string[]> {
	return listUsableModels(await getApiKey(env, userId));
}

export async function saveModels(
	env: AppEnv,
	userId: string,
	model: string,
	visionModel: string,
): Promise<void> {
	// 임의의 문자열이 저장되면 나중에 호출이 통째로 실패한다. 계정에서 실제로 쓸 수 있는지 확인한다.
	const available = await listModels(env, userId);
	for (const candidate of [model, visionModel]) {
		if (!available.includes(candidate)) throw invalid("사용할 수 없는 모델입니다.");
	}
	await settingsRepo.saveModels(env, userId, { model, visionModel });
}

/** AI 서비스 전용. 복호화된 키가 나가는 유일한 통로다. */
export async function getApiKey(env: AppEnv, userId: string): Promise<string> {
	const row = await settingsRepo.find(env, userId);
	if (!row?.openai_api_key_cipher || !row.openai_api_key_iv) {
		throw new ApiError("invalid", "먼저 설정 화면에서 OpenAI API Key 를 등록해 주세요.", 400);
	}
	return unseal(env, { cipher: row.openai_api_key_cipher, iv: row.openai_api_key_iv });
}

/** 부모가 고른 모델. 없으면 호출 시점에 계정에서 다시 고른다. */
export async function getModels(
	env: AppEnv,
	userId: string,
): Promise<{ model: string; visionModel: string }> {
	const row = await settingsRepo.find(env, userId);
	if (row?.openai_model) {
		return { model: row.openai_model, visionModel: row.openai_vision_model ?? row.openai_model };
	}

	const available = await listModels(env, userId);
	const fallback = pickDefault(available);
	if (!fallback) throw new ApiError("ai_failed", "사용할 수 있는 모델이 없습니다.", 502);

	await settingsRepo.saveModels(env, userId, { model: fallback, visionModel: fallback });
	return { model: fallback, visionModel: fallback };
}
