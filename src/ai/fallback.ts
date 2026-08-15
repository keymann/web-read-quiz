import { ApiError } from "../utils/response";
import type { AiProvider } from "./types";

/**
 * 모델 폴백.
 *
 * 부모가 고른 모델이 늘 쓸 수 있는 것은 아니다. 실제로 겪은 것들:
 *  - `503 UNAVAILABLE` — 인기 모델은 과부하가 잦다. 재시도해도 계속 막힐 때가 있다.
 *  - `404` — 목록에는 뜨는데 실제 호출은 안 되는 모델이 섞여 있다.
 *  - `429` — 모델별 분당·일일 한도.
 * 이 경우 다른 모델로 넘어가면 대부분 그냥 성공한다. 부모에게 "지금 안 되니 설정에서 모델을
 * 바꿔 보라"고 떠넘길 이유가 없다.
 *
 * 폴백하지 않는 경우:
 *  - `invalid` (키가 틀림 · 크레딧 부족) — 모델을 바꿔도 똑같다.
 *  - `search_unavailable` (그라운딩 권한 없음) — 계정 등급 문제라 모델과 무관하다.
 */

/** 원래 모델까지 포함해 최대 몇 개를 시도할지. 너무 많이 돌면 응답이 하염없이 늦어진다. */
const MAX_MODELS = 3;

const isTransient = (err: unknown): boolean =>
	err instanceof ApiError && err.code === "ai_failed";

export interface FallbackResult<T> {
	value: T;
	/** 실제로 성공한 모델. */
	modelUsed: string;
	/** 폴백이 일어났으면 원래 고른 모델, 아니면 null. */
	fellBackFrom: string | null;
}

export async function withModelFallback<T>(
	provider: AiProvider,
	apiKey: string,
	preferredModel: string,
	run: (model: string) => Promise<T>,
): Promise<FallbackResult<T>> {
	try {
		return { value: await run(preferredModel), modelUsed: preferredModel, fellBackFrom: null };
	} catch (err) {
		if (!isTransient(err)) throw err;

		// 후보 목록은 **실패한 뒤에만** 조회한다. 정상 경로에 호출을 하나 더 얹지 않기 위해서다.
		let candidates: string[];
		try {
			candidates = await provider.listModels(apiKey);
		} catch {
			throw err; // 목록조차 못 가져오면 원래 에러가 더 유용하다
		}

		const alternatives = candidates.filter((m) => m !== preferredModel).slice(0, MAX_MODELS - 1);
		let lastError = err;

		for (const model of alternatives) {
			try {
				console.warn(`model fallback: ${preferredModel} → ${model}`);
				return { value: await run(model), modelUsed: model, fellBackFrom: preferredModel };
			} catch (nextErr) {
				if (!isTransient(nextErr)) throw nextErr;
				lastError = nextErr;
			}
		}

		throw lastError;
	}
}
