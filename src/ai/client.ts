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

		const error = await toApiError(response);

		// 4xx 는 다시 보내도 같은 결과다. 429 와 5xx 만 재시도한다.
		const retryable = response.status === 429 || response.status >= 500;
		if (!retryable || attempt === maxAttempts) throw error;

		lastError = error;
		await backoff(attempt, response.headers.get("Retry-After"));
	}

	throw lastError ?? new ApiError("ai_failed", "AI 호출에 실패했습니다.", 502);
}

async function toApiError(response: Response): Promise<ApiError> {
	let detail = "";
	try {
		const body = (await response.json()) as { error?: { message?: string } };
		detail = body.error?.message ?? "";
	} catch {
		/* 본문이 JSON 이 아니면 상태 코드만으로 판단한다 */
	}

	if (response.status === 401) {
		return new ApiError("invalid", "OpenAI API Key 가 올바르지 않습니다. 다시 확인해 주세요.", 400);
	}
	if (response.status === 429) {
		return new ApiError("ai_failed", "OpenAI 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.", 502);
	}
	if (response.status === 403) {
		return new ApiError("invalid", "이 API Key 로는 사용할 수 없는 요청입니다.", 400);
	}

	console.error("openai error", response.status, detail);
	return new ApiError("ai_failed", "AI 호출에 실패했습니다.", 502);
}

/** 1초 → 2초 → 4초. Retry-After 가 오면 그 값을 우선한다. */
async function backoff(attempt: number, retryAfter?: string | null): Promise<void> {
	const fromHeader = retryAfter === null || retryAfter === undefined ? NaN : Number(retryAfter);
	const seconds = Number.isFinite(fromHeader) ? Math.min(fromHeader, 10) : 2 ** (attempt - 1);
	await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
