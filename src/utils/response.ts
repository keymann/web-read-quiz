import type { ApiResponse } from "../types";

const BASE_HEADERS: Record<string, string> = {
	"Content-Type": "application/json; charset=utf-8",
	"Cache-Control": "no-store",
	// 브라우저가 JSON 응답을 다른 타입으로 추측해 실행하지 못하게 한다.
	"X-Content-Type-Options": "nosniff",
};

export function ok<T>(data: T, status = 200, extra?: Record<string, string>): Response {
	return new Response(JSON.stringify({ ok: true, data } satisfies ApiResponse<T>), {
		status,
		headers: { ...BASE_HEADERS, ...extra },
	});
}

export function fail(
	code: string,
	message: string,
	status = 400,
	extra?: Record<string, string>,
): Response {
	const body: ApiResponse<never> = { ok: false, error: { code, message } };
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...BASE_HEADERS, ...extra },
	});
}

/** 라우트/서비스에서 던지면 `toResponse` 가 일관된 에러 응답으로 바꾼다(§31.13). */
export class ApiError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
		readonly headers?: Record<string, string>,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export const invalid = (message: string) => new ApiError("invalid", message, 400);
export const unauthorized = (message = "로그인이 필요합니다.") =>
	new ApiError("unauthorized", message, 401);
export const forbidden = (message = "권한이 없습니다.") => new ApiError("forbidden", message, 403);
export const notFound = (message = "대상을 찾을 수 없습니다.") =>
	new ApiError("not_found", message, 404);
export const conflict = (message: string) => new ApiError("conflict", message, 409);

export function toResponse(err: unknown): Response {
	if (err instanceof ApiError) return fail(err.code, err.message, err.status, err.headers);
	console.error("unhandled error", err);
	return fail("internal", "요청을 처리하지 못했습니다.", 500);
}
