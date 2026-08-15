import { ApiError } from "../utils/response";

/**
 * OpenAI HTTP 호출 래퍼.
 *
 * 여기 말고 다른 곳에서 `api.openai.com` 을 직접 부르지 않는다. 타임아웃·재시도·에러 변환을
 * 한 곳에 모아 두어야 문제 생성 파이프라인(Phase 4)에서 실패 처리를 일관되게 할 수 있다.
 */
const BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

export interface CallOptions {
	timeoutMs?: number;
	/** 429·5xx 재시도 횟수. 멱등하지 않은 호출에서는 1 로 둔다. */
	maxAttempts?: number;
}

export async function callOpenAi<T>(
	apiKey: string,
	path: string,
	init: RequestInit = {},
	options: CallOptions = {},
): Promise<T> {
	const { timeoutMs = DEFAULT_TIMEOUT_MS, maxAttempts = MAX_ATTEMPTS } = options;

	let lastError: ApiError | null = null;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		let response: Response;
		try {
			response = await fetch(`${BASE_URL}${path}`, {
				...init,
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					...init.headers,
				},
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch {
			lastError = new ApiError("ai_failed", "AI 서버에 연결하지 못했습니다.", 502);
			if (attempt < maxAttempts) {
				await backoff(attempt);
				continue;
			}
			throw lastError;
		}

		if (response.ok) return (await response.json()) as T;

		const { error, retryable } = await toApiError(response);
		if (!retryable || attempt === maxAttempts) throw error;

		lastError = error;
		await backoff(attempt, response.headers.get("Retry-After"));
	}

	throw lastError ?? new ApiError("ai_failed", "AI 호출에 실패했습니다.", 502);
}

interface Classified {
	error: ApiError;
	/** 다시 보내면 성공할 가능성이 있는가. 없으면 백오프 시간만 낭비한다. */
	retryable: boolean;
}

async function toApiError(response: Response): Promise<Classified> {
	let message = "";
	let code = "";
	try {
		const body = (await response.json()) as { error?: { message?: string; code?: string; type?: string } };
		message = body.error?.message ?? "";
		code = body.error?.code ?? body.error?.type ?? "";
	} catch {
		/* 본문이 JSON 이 아니면 상태 코드만으로 판단한다 */
	}

	// 원인 진단에 필요하다. 키는 헤더에만 있으므로 본문을 남겨도 유출되지 않는다.
	console.error(`openai ${response.status} ${code}: ${message.slice(0, 300)}`);

	if (response.status === 401) {
		return {
			error: new ApiError("invalid", "OpenAI API Key 가 올바르지 않습니다. 다시 확인해 주세요.", 400),
			retryable: false,
		};
	}

	if (response.status === 429) {
		// 429 는 두 가지가 섞여 있다. 크레딧 소진은 기다려도 풀리지 않으므로 재시도하지 않고
		// 결제 설정을 안내한다. 잠깐의 호출량 초과와 구분해서 알려야 부모가 대응할 수 있다.
		if (code === "insufficient_quota" || message.includes("quota")) {
			return {
				error: new ApiError(
					"invalid",
					"OpenAI 크레딧이 부족합니다. platform.openai.com 의 Billing 에서 결제 수단과 잔액을 확인해 주세요.",
					400,
				),
				retryable: false,
			};
		}
		return {
			error: new ApiError("ai_failed", "OpenAI 호출량 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요.", 502),
			retryable: true,
		};
	}

	if (response.status === 403) {
		return {
			error: new ApiError("invalid", "이 API Key 로는 사용할 수 없는 요청입니다.", 400),
			retryable: false,
		};
	}

	if (response.status === 400) {
		return {
			error: new ApiError("ai_failed", `AI 요청이 거부되었습니다. (${code || "bad_request"})`, 502),
			retryable: false,
		};
	}

	return {
		error: new ApiError("ai_failed", "AI 호출에 실패했습니다.", 502),
		// 5xx 만 일시적 장애로 본다.
		retryable: response.status >= 500,
	};
}

/** 1초 → 2초 → 4초. Retry-After 가 오면 그 값을 우선한다. */
async function backoff(attempt: number, retryAfter?: string | null): Promise<void> {
	const fromHeader = retryAfter === null || retryAfter === undefined ? NaN : Number(retryAfter);
	const seconds = Number.isFinite(fromHeader) ? Math.min(fromHeader, 10) : 2 ** (attempt - 1);
	await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
