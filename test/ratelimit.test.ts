import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { rateLimit, rateLimitLocal } from "../src/utils/ratelimit";
import { uniqueId } from "./helpers";

/**
 * Rate Limit — **어디에 세는지**가 이 파일의 주제다.
 *
 * 2026-08-23 에 앱 전체가 멈췄다. 전역 제한이 KV 에 세고 있었고 그것이 요청마다 쓰기 한 번이라,
 * 무료 등급 하루 1,000회를 문제 만들기 19번으로 태웠다(생성 화면이 2분에 51번 폴링한다).
 * 한도가 마르면 `put` 이 던지고 그 예외가 전역 제한에서 나오므로 **모든 API 가 500** 이 됐다.
 *
 * 그래서 여기서 지키려는 것은 두 가지다.
 *   1. 전역 제한은 KV 를 **한 번도** 쓰지 않는다
 *   2. 그러면서도 쏟아붓는 요청은 여전히 막는다
 */

/*
 * "KV 를 쓰지 않는다" 는 테스트가 아니라 **시그니처가 보증한다.** `rateLimitLocal` 은 `env` 를
 * 받지 않으므로 바인딩에 닿을 방법이 없고, 비동기도 아니다. 가짜 바인딩을 주고 안 터지는지
 * 보는 것은 그 사실을 흉내만 내는 것이라 여기서는 동작만 확인한다.
 */
describe("전역 제한", () => {
	it("한도까지는 통과하고 넘으면 429 로 막는다", () => {
		const subject = uniqueId("ip");

		for (let i = 0; i < 5; i++) {
			expect(() => rateLimitLocal("burst", subject, 5, 60)).not.toThrow();
		}

		try {
			rateLimitLocal("burst", subject, 5, 60);
			throw new Error("막지 않았다");
		} catch (err) {
			expect((err as { status: number }).status).toBe(429);
			expect((err as { code: string }).code).toBe("rate_limited");
		}
	});

	// 남은 시간을 알려 줘야 클라이언트가 언제 다시 걸지 정할 수 있다.
	it("Retry-After 를 함께 준다", () => {
		const subject = uniqueId("ip");
		rateLimitLocal("retry-hdr", subject, 1, 60);

		try {
			rateLimitLocal("retry-hdr", subject, 1, 60);
			throw new Error("막지 않았다");
		} catch (err) {
			const headers = (err as { headers?: Record<string, string> }).headers ?? {};
			expect(Number(headers["Retry-After"])).toBeGreaterThan(0);
			expect(Number(headers["Retry-After"])).toBeLessThanOrEqual(60);
		}
	});

	// 한 사람이 쏟아부었다고 다른 사람이 막히면 안 된다.
	it("주체마다 따로 센다", () => {
		const mine = uniqueId("ip");
		const theirs = uniqueId("ip");

		rateLimitLocal("split", mine, 1, 60);
		expect(() => rateLimitLocal("split", mine, 1, 60)).toThrow();
		// 다른 주체는 그대로 통과한다.
		expect(() => rateLimitLocal("split", theirs, 1, 60)).not.toThrow();
	});

	// 스코프가 다르면 다른 통이다. 전역 제한과 로그인 제한이 서로 잡아먹으면 안 된다.
	it("스코프마다 따로 센다", () => {
		const subject = uniqueId("ip");

		rateLimitLocal("scope-a", subject, 1, 60);
		expect(() => rateLimitLocal("scope-a", subject, 1, 60)).toThrow();
		expect(() => rateLimitLocal("scope-b", subject, 1, 60)).not.toThrow();
	});

	/**
	 * 창이 지나면 다시 센다. `windowSeconds` 를 0 으로 주면 창이 곧바로 지난 셈이 되어,
	 * 시계를 건드리지 않고 그 경계를 확인할 수 있다.
	 */
	it("창이 지나면 다시 센다", () => {
		const subject = uniqueId("ip");

		rateLimitLocal("window", subject, 1, 0);
		expect(() => rateLimitLocal("window", subject, 1, 0)).not.toThrow();
	});
});

describe("비싼 조작은 여전히 KV 로 센다", () => {
	/**
	 * 무차별 대입과 AI 폭주는 정확히 세야 한다 — isolate 를 넘나들어도 막혀야 하기 때문이다.
	 * 그 조작들은 사용자당 시간당 스무 번 남짓이라 하루 1,000회 쓰기에 닿지 않는다.
	 */
	it("한도를 넘으면 막는다", async () => {
		const subject = uniqueId("user");

		await rateLimit(env as never, "kv-scope", subject, 2, 60);
		await rateLimit(env as never, "kv-scope", subject, 2, 60);

		await expect(rateLimit(env as never, "kv-scope", subject, 2, 60)).rejects.toThrow(/잦습니다/);
	});
});
