import type { AppEnv } from "../types";
import { ApiError } from "./response";

/**
 * KV 기반 고정 윈도우 Rate Limit.
 *
 * KV 는 read-modify-write 가 원자적이지 않아 동시 요청이 몰리면 카운트가 조금 새어나갈 수 있다.
 * 여기서 막으려는 것은 정밀한 쿼터가 아니라 무차별 대입·AI 호출 폭주이므로 이 정도 정확도로 충분하다.
 * 엄밀한 제한이 필요해지면 Durable Object 로 옮긴다.
 */
export async function rateLimit(
	env: AppEnv,
	scope: string,
	subject: string,
	limit: number,
	windowSeconds: number,
): Promise<void> {
	const window = Math.floor(Date.now() / 1000 / windowSeconds);
	const key = `rl:${scope}:${subject}:${window}`;

	const current = Number((await env.SESSIONS.get(key)) ?? "0");
	if (current >= limit) {
		const retryAfter = String((window + 1) * windowSeconds - Math.floor(Date.now() / 1000));
		throw new ApiError("rate_limited", "요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.", 429, {
			"Retry-After": retryAfter,
		});
	}

	// 윈도우가 끝나면 자연히 사라지도록 TTL 을 건다. KV 최소 TTL 은 60초.
	await env.SESSIONS.put(key, String(current + 1), {
		expirationTtl: Math.max(60, windowSeconds),
	});
}

/** 프록시 뒤에서도 신뢰할 수 있는 클라이언트 주소. Cloudflare 가 채워준다. */
export const clientIp = (request: Request): string =>
	request.headers.get("CF-Connecting-IP") ?? "unknown";
