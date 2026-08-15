import { providerFor, providerChoices } from "../ai";
import type { AiProvider, ProviderName } from "../ai/types";
import * as settingsRepo from "../repositories/settings";
import type { AppEnv } from "../types";
import { seal, unseal } from "../utils/crypto";
import { ApiError, invalid } from "../utils/response";

/**
 * 부모 설정 — AI 제공자 선택과 API Key 보관.
 *
 * 이 모듈 밖으로 **복호화된 키가 나가는 경로는 `getRuntime` 하나뿐**이고, 그 반환값은
 * AI 서비스가 제공자를 호출할 때만 쓴다. 라우트가 응답에 담을 일이 없도록 분리했다.
 */

const DEFAULT_PROVIDER: ProviderName = "openai";

/** 요구사항 §17·§21.1 의 기본값. 부모가 설정에서 바꿀 수 있다. */
export const DEFAULT_QUESTION_COUNT = 20;
export const DEFAULT_PASS_COUNT = 10;

/**
 * 출제 문항 수의 허용 범위.
 * 아래로는 통과 기준을 세울 수 없을 만큼 적고, 위로는 아이의 집중력과 AI 응답 길이가 감당하지 못한다.
 */
const MIN_QUESTIONS = 5;
const MAX_QUESTIONS = 30;

/** 클라이언트에 내보내는 설정. 키 원문은 절대 포함하지 않는다(§21.9). */
export interface SettingsView {
	provider: ProviderName;
	providers: { name: ProviderName; label: string; consoleUrl: string }[];
	ai: {
		configured: boolean;
		last4: string | null;
		model: string | null;
		visionModel: string | null;
	};
	quiz: {
		questionCount: number;
		passCount: number;
		minQuestions: number;
		maxQuestions: number;
	};
}

export async function getView(env: AppEnv, userId: string): Promise<SettingsView> {
	const row = await settingsRepo.find(env, userId);
	return {
		provider: row?.ai_provider ?? DEFAULT_PROVIDER,
		providers: providerChoices(),
		ai: {
			configured: row?.api_key_cipher !== null && row?.api_key_cipher !== undefined,
			last4: row?.api_key_last4 ?? null,
			model: row?.text_model ?? null,
			visionModel: row?.vision_model ?? null,
		},
		quiz: {
			questionCount: row?.question_count ?? DEFAULT_QUESTION_COUNT,
			passCount: row?.pass_count ?? DEFAULT_PASS_COUNT,
			minQuestions: MIN_QUESTIONS,
			maxQuestions: MAX_QUESTIONS,
		},
	};
}

/** 퀴즈를 만들 때 복사해 갈 값. 설정이 없으면 기본값. */
export async function getQuizSettings(
	env: AppEnv,
	userId: string,
): Promise<{ questionCount: number; passCount: number }> {
	const row = await settingsRepo.find(env, userId);
	return {
		questionCount: row?.question_count ?? DEFAULT_QUESTION_COUNT,
		passCount: row?.pass_count ?? DEFAULT_PASS_COUNT,
	};
}

export async function saveQuizSettings(
	env: AppEnv,
	userId: string,
	questionCount: number,
	passCount: number,
): Promise<{ questionCount: number; passCount: number }> {
	if (!Number.isInteger(questionCount) || questionCount < MIN_QUESTIONS || questionCount > MAX_QUESTIONS) {
		throw invalid(`문제 개수는 ${MIN_QUESTIONS}~${MAX_QUESTIONS} 사이로 정해 주세요.`);
	}
	// 통과 기준이 문항 수보다 크면 아무도 통과할 수 없다. 0 이면 누구나 통과한다.
	if (!Number.isInteger(passCount) || passCount < 1 || passCount > questionCount) {
		throw invalid(`통과 개수는 1 이상 ${questionCount} 이하로 정해 주세요.`);
	}

	await settingsRepo.saveQuizSettings(env, userId, { questionCount, passCount });
	return { questionCount, passCount };
}

export interface SaveKeyResult {
	provider: ProviderName;
	last4: string;
	models: string[];
	model: string | null;
	/** 키는 유효하지만 실제 호출이 안 되는 경우(크레딧 부족 등)의 안내. 정상이면 null. */
	warning: string | null;
}

/**
 * 키를 저장하기 전에 제공자에게 한 번 물어본다.
 * 잘못된 키가 저장되면 그 사실을 문제 생성 단계에서야 알게 되어 진단이 어렵다.
 */
export async function saveKey(
	env: AppEnv,
	userId: string,
	providerName: ProviderName,
	apiKey: string,
): Promise<SaveKeyResult> {
	const provider = providerFor(providerName);
	const trimmed = apiKey.trim();

	provider.assertKeyFormat(trimmed);
	if (trimmed.length < 20 || trimmed.length > 300) throw invalid("API Key 형식이 올바르지 않습니다.");

	const models = await provider.listModels(trimmed);
	if (models.length === 0) {
		throw invalid(`이 키로 사용할 수 있는 ${provider.label} 모델이 없습니다. 계정 설정을 확인해 주세요.`);
	}

	const sealed = await seal(env, trimmed);
	const last4 = trimmed.slice(-4);
	await settingsRepo.saveKey(env, userId, { provider: providerName, ...sealed, last4 });

	// 아직 고른 모델이 없으면 선호 순서의 첫 모델을 기본으로 잡아 준다.
	const existing = await settingsRepo.find(env, userId);
	let model = existing?.text_model ?? null;
	if (model === null || !models.includes(model)) {
		model = models[0] ?? null;
		await settingsRepo.saveModels(env, userId, { model, visionModel: model });
	}

	// 목록 조회는 인증만 확인한다. 실제로 추론이 되는지는 따로 확인해야 크레딧·권한 문제를
	// 문제 생성 단계가 아니라 지금 이 화면에서 알려줄 수 있다.
	const warning = model ? await provider.probe(trimmed, model) : null;

	return { provider: providerName, last4, models, model, warning };
}

export async function clearKey(env: AppEnv, userId: string): Promise<void> {
	await settingsRepo.clearKey(env, userId);
}

export async function listModels(env: AppEnv, userId: string): Promise<string[]> {
	const { provider, apiKey } = await getRuntime(env, userId);
	return provider.listModels(apiKey);
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

export interface AiRuntime {
	provider: AiProvider;
	apiKey: string;
	model: string;
	visionModel: string;
}

/**
 * AI 서비스 전용. 복호화된 키가 나가는 유일한 통로다.
 * 제공자 · 키 · 모델을 한 번에 돌려줘 호출부가 세 곳을 따로 조회하지 않게 한다.
 */
export async function getRuntime(env: AppEnv, userId: string): Promise<AiRuntime> {
	const row = await settingsRepo.find(env, userId);
	if (!row?.api_key_cipher || !row.api_key_iv) {
		throw new ApiError("invalid", "먼저 설정 화면에서 AI API Key 를 등록해 주세요.", 400);
	}

	const provider = providerFor(row.ai_provider ?? DEFAULT_PROVIDER);
	const apiKey = await unseal(env, { cipher: row.api_key_cipher, iv: row.api_key_iv });

	if (row.text_model) {
		return {
			provider,
			apiKey,
			model: row.text_model,
			visionModel: row.vision_model ?? row.text_model,
		};
	}

	// 모델이 비어 있으면(제공자를 막 바꾼 직후 등) 지금 계정에서 다시 고른다.
	const available = await provider.listModels(apiKey);
	const fallback = available[0];
	if (!fallback) throw new ApiError("ai_failed", "사용할 수 있는 모델이 없습니다.", 502);

	await settingsRepo.saveModels(env, userId, { model: fallback, visionModel: fallback });
	return { provider, apiKey, model: fallback, visionModel: fallback };
}
