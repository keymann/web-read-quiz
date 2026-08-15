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
		/** 어떤 자격증명을 등록했는지 알려주는 짧은 문구. 키 원문은 담기지 않는다. */
		keyHint: string | null;
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
			keyHint: row?.api_key_last4 ?? null,
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
	keyHint: string;
	models: string[];
	model: string | null;
	/** 키는 유효하지만 실제 호출이 안 되는 경우(크레딧 부족 등)의 안내. 정상이면 null. */
	warning: string | null;
}

/**
 * 제공자가 이 서버에서 호출 가능한지.
 *
 * Gemini(AI Studio)는 요청을 보낸 서버의 위치를 보고 막는다. 배포 환경(Cloudflare)에서는
 * 서버가 Gemini 를 **한 번도** 부를 수 없다 — 키 검증도, 모델 목록 조회도 마찬가지다.
 * 그래서 Gemini 는 브라우저가 대신 부르고, 서버는 받은 결과를 저장만 한다.
 */
const callableFromServer = (provider: ProviderName): boolean => provider !== "gemini";

/**
 * 키를 저장한다.
 *
 * 서버가 부를 수 있는 제공자는 저장 전에 직접 확인한다. 잘못된 키가 저장되면 그 사실을
 * 문제 생성 단계에서야 알게 되어 진단이 어렵다.
 *
 * Gemini 는 서버가 부를 수 없으므로 **브라우저가 미리 조회한 모델 목록**을 함께 받는다.
 * 그 조회가 성공했다는 것 자체가 키가 유효하다는 증거다.
 */
export async function saveKey(
	env: AppEnv,
	userId: string,
	providerName: ProviderName,
	apiKey: string,
	/** 브라우저가 조회해 온 모델 목록. Gemini 에서는 필수. */
	browserModels?: string[],
): Promise<SaveKeyResult> {
	const provider = providerFor(providerName);
	const trimmed = apiKey.trim();

	// 형식 검증은 제공자가 한다. Vertex 는 API Key 한 줄이 아니라 서비스 계정 JSON 전체를 받으므로
	// 길이 상한을 여기서 일괄로 두면 멀쩡한 자격증명을 거부하게 된다.
	if (trimmed.length < 20 || trimmed.length > 8_000) throw invalid("자격증명 형식이 올바르지 않습니다.");
	provider.assertKeyFormat(trimmed);

	// 목록을 누가 가져왔든 무엇을 쓸 수 있고 무엇이 먼저인지는 서버가 정한다.
	const models = callableFromServer(providerName)
		? await provider.listModels(trimmed)
		: (provider.normalizeModels?.(browserModels ?? []) ?? []);

	if (models.length === 0) {
		throw invalid(
			callableFromServer(providerName)
				? `이 키로 사용할 수 있는 ${provider.label} 모델이 없습니다. 계정 설정을 확인해 주세요.`
				: "모델 목록을 확인하지 못했습니다. 키를 다시 확인해 주세요.",
		);
	}

	const sealed = await seal(env, trimmed);
	const keyHint = provider.keyLabel(trimmed);
	await settingsRepo.saveKey(env, userId, { provider: providerName, ...sealed, last4: keyHint });

	// 아직 고른 모델이 없으면 선호 순서의 첫 모델을 기본으로 잡아 준다.
	const existing = await settingsRepo.find(env, userId);
	let model = existing?.text_model ?? null;
	if (model === null || !models.includes(model)) {
		model = models[0] ?? null;
		await settingsRepo.saveModels(env, userId, { model, visionModel: model });
	}

	// 목록 조회는 인증만 확인한다. 실제로 추론이 되는지는 따로 확인해야 크레딧·권한 문제를
	// 문제 생성 단계가 아니라 지금 이 화면에서 알려줄 수 있다.
	// 서버가 부를 수 없는 제공자는 이 확인을 건너뛴다 — 첫 사용 때 브라우저가 알게 된다.
	const warning =
		model && callableFromServer(providerName) ? await provider.probe(trimmed, model) : null;

	return { provider: providerName, keyHint, models, model, warning };
}

export async function clearKey(env: AppEnv, userId: string): Promise<void> {
	await settingsRepo.clearKey(env, userId);
}

/**
 * 이 계정에서 쓸 수 있는 모델 목록.
 *
 * Gemini 는 서버에서 조회할 수 없다. 그 경우 브라우저가 직접 조회해야 하므로 여기서 막는다.
 */
export async function listModels(env: AppEnv, userId: string): Promise<string[]> {
	const { provider, apiKey } = await getRuntime(env, userId);
	if (!callableFromServer(provider.name)) {
		throw new ApiError(
			"region_blocked",
			"이 제공자의 모델 목록은 서버에서 조회할 수 없습니다. 화면에서 다시 시도해 주세요.",
			400,
		);
	}
	return provider.listModels(apiKey);
}

export async function saveModels(
	env: AppEnv,
	userId: string,
	model: string,
	visionModel: string,
): Promise<void> {
	const row = await settingsRepo.find(env, userId);
	const providerName = row?.ai_provider ?? DEFAULT_PROVIDER;

	// 임의의 문자열이 저장되면 나중에 호출이 통째로 실패한다. 계정에서 실제로 쓸 수 있는지 확인한다.
	// 서버가 목록을 조회할 수 없는 제공자(Gemini)는 이 확인을 할 방법이 없다. 목록을 보여준
	// 주체가 브라우저이고 부모는 거기서 고른 것이므로, 형식만 확인하고 받아들인다.
	if (callableFromServer(providerName)) {
		const available = await listModels(env, userId);
		for (const candidate of [model, visionModel]) {
			if (!available.includes(candidate)) throw invalid("사용할 수 없는 모델입니다.");
		}
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
	// saveKey 가 항상 모델을 채우므로 정상 경로에서는 오지 않는다.
	if (!callableFromServer(provider.name)) {
		throw new ApiError("invalid", "사용할 모델이 정해지지 않았습니다. 설정에서 다시 저장해 주세요.", 400);
	}
	const available = await provider.listModels(apiKey);
	const fallback = available[0];
	if (!fallback) throw new ApiError("ai_failed", "사용할 수 있는 모델이 없습니다.", 502);

	await settingsRepo.saveModels(env, userId, { model: fallback, visionModel: fallback });
	return { provider, apiKey, model: fallback, visionModel: fallback };
}
