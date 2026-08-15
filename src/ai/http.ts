import { ApiError } from "../utils/response";
import type { CallOptions, Classify } from "./types";

/**
 * AI 제공자 공통 HTTP 호출부 — 타임아웃 · 백오프 재시도 · 에러 변환.
 *
 * 어떤 응답이 재시도할 만한지는 제공자마다 다르므로 `classify` 로 받는다.
 * 여기 말고 다른 곳에서 제공자 API 를 직접 부르지 않는다.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

export async function requestJson<T>(
	url: string,
	init: RequestInit,
	classify: Classify,
	options: CallOptions = {},
): Promise<T> {
	const { timeoutMs = DEFAULT_TIMEOUT_MS, maxAttempts = MAX_ATTEMPTS } = options;

	let lastError: ApiError | null = null;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		let response: Response;
		try {
			response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
		} catch {
			lastError = new ApiError("ai_failed", "AI 서버에 연결하지 못했습니다.", 502);
			if (attempt < maxAttempts) {
				await backoff(attempt);
				continue;
			}
			throw lastError;
		}

		if (response.ok) return (await response.json()) as T;

		let body: unknown = null;
		try {
			body = await response.json();
		} catch {
			/* 본문이 JSON 이 아니면 상태 코드만으로 판단한다 */
		}

		const { error, retryable } = classify(response.status, body);
		if (!retryable || attempt === maxAttempts) throw error;

		lastError = error;
		await backoff(attempt, response.headers.get("Retry-After"));
	}

	throw lastError ?? new ApiError("ai_failed", "AI 호출에 실패했습니다.", 502);
}

/** 1초 → 2초 → 4초. Retry-After 가 오면 그 값을 우선한다. */
async function backoff(attempt: number, retryAfter?: string | null): Promise<void> {
	const fromHeader = retryAfter === null || retryAfter === undefined ? NaN : Number(retryAfter);
	const seconds = Number.isFinite(fromHeader) ? Math.min(fromHeader, 10) : 2 ** (attempt - 1);
	await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** 제공자별 분류기에서 공통으로 쓰는 진단 로그. 키는 헤더에만 있으므로 본문은 남겨도 안전하다. */
export function logAiError(provider: string, status: number, code: string, message: string): void {
	console.error(`${provider} ${status} ${code}: ${message.slice(0, 300)}`);
}

/** JSON 문자열을 결과 객체로. 구조화 출력을 걸었으므로 정상 경로에서는 실패하지 않는다. */
export function parseStructured<T>(provider: string, text: string | null): T {
	if (text === null || text.trim() === "") {
		throw new ApiError("ai_failed", "AI 응답을 읽을 수 없습니다.", 502);
	}
	try {
		return JSON.parse(text) as T;
	} catch {
		console.error(`${provider} structured output parse failed`, text.slice(0, 200));
		throw new ApiError("ai_failed", "AI 응답 형식이 올바르지 않습니다.", 502);
	}
}
