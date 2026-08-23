import type { AppEnv } from "../types";
import { ApiError } from "./response";

/**
 * Rate Limit — **두 벌이다.** 무엇을 막느냐에 따라 값을 어디에 세는지가 다르다.
 *
 *   `rateLimit`      KV 에 센다. 드물고 비싼 조작에만 쓴다(로그인·AI·업로드)
 *   `rateLimitLocal` isolate 메모리에 센다. **모든 요청을 지나는 전역 제한**에 쓴다
 *
 * 나눈 이유는 실제로 겪은 장애다(2026-08-23). 전역 제한이 KV 에 세고 있었고, 그것이 요청마다
 * 쓰기 한 번이었다. 무료 등급 KV 는 **하루 쓰기 1,000회**라 문제 만들기 19번이면 바닥났다
 * (생성 화면이 1~2초 간격으로 폴링해 2분에 51회를 쓴다). 바닥나면 `put` 이 던지고,
 * 그 예외가 전역 제한에서 나오므로 **모든 API 가 500** 이 됐다. 로그인조차 막혔다.
 *
 * 무료 등급 읽기는 하루 100,000회라 읽기 쪽은 여유가 있다. 문제는 쓰기뿐이었다.
 */

/* ── isolate 메모리 카운터 ───────────────────────────── */

/**
 * isolate 안에서만 세는 카운터. **KV 를 쓰지 않는다.**
 *
 * isolate 는 colo 마다 따로 있고 수시로 버려지므로 이 값은 전역 진실이 아니다. 그래도 전역
 * 제한이 막으려는 것 — 한 클라이언트가 쏟아붓는 요청 — 은 같은 colo 로 들어와 같은 isolate 를
 * 지나므로 대부분 걸린다.
 *
 * 정확히 세야 하는 것은 여전히 KV 가 맡는다. 무차별 대입은 `auth` 스코프가, AI 폭주는 `ai`
 * 스코프가 막고, 그 둘은 사용자당 시간당 스무 번 남짓이라 쓰기 한도에 닿지 않는다.
 */
const counters = new Map<string, { count: number; resetAt: number }>();

/**
 * 들고 있을 카운터 수의 상한.
 *
 * isolate 는 요청 사이에 살아 있으므로 이 Map 도 남는다. 서로 다른 IP 가 계속 들어오면
 * 무한히 자라 메모리를 먹는다.
 */
const MAX_COUNTERS = 10_000;

/** 지난 창은 버린다. 부를 때마다 훑으므로 따로 타이머를 두지 않는다. */
function sweep(now: number): void {
	for (const [key, hit] of counters) {
		if (hit.resetAt <= now) counters.delete(key);
	}

	/*
	 * 쓸어내고도 상한을 넘으면 **통째로 비운다.**
	 *
	 * 그 순간 세던 값이 사라져 잠시 제한이 느슨해진다. 그래도 메모리를 계속 먹는 쪽보다 낫고,
	 * 여기까지 오려면 살아 있는 창 안에 만 개가 넘는 서로 다른 IP 가 들어와야 한다 — 그런
	 * 분산 홍수는 IP 단위 카운터로 애초에 막지 못한다.
	 */
	if (counters.size > MAX_COUNTERS) counters.clear();
}

/**
 * 전역 호출량 제한. **KV 를 쓰지 않으므로 요청마다 불러도 된다.**
 *
 * 비동기가 아니다. 기다릴 것이 없다는 사실이 부르는 쪽에 드러나야 한다.
 */
export function rateLimitLocal(
	scope: string,
	subject: string,
	limit: number,
	windowSeconds: number,
): void {
	const now = Date.now();
	sweep(now);

	const key = `${scope}:${subject}`;
	const hit = counters.get(key);

	if (!hit || hit.resetAt <= now) {
		counters.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
		return;
	}

	hit.count++;
	if (hit.count > limit) {
		const retryAfter = String(Math.max(1, Math.ceil((hit.resetAt - now) / 1000)));
		throw new ApiError("rate_limited", "요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.", 429, {
			"Retry-After": retryAfter,
		});
	}
}

/* ── KV 카운터 ───────────────────────────────────────── */

/**
 * KV 기반 고정 윈도우 Rate Limit. **드물고 비싼 조작에만 쓴다.**
 *
 * 요청마다 쓰기 한 번이므로 모든 요청을 지나는 자리에 두면 안 된다(위 머리말의 장애).
 * 지금 이걸 쓰는 곳은 로그인·가입·AI 호출·표지 업로드처럼 사용자당 시간당 스무 번 남짓인
 * 조작들이다.
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
