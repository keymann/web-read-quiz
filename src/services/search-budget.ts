import type { AppEnv } from "../types";

/**
 * Tavily 월 크레딧 예산 (§docs/tavily-search-plan.md §4.4).
 *
 * 무료 등급은 **월 1,000 크레딧**이고, 그것은 조용히 넘길 수 있는 숫자다. 넘기면 그 달의
 * 남은 기간 동안 모든 부모의 웹 검색이 죽는다. 그래서 어댑터보다 이것이 먼저 있어야 한다.
 *
 * KV 는 read-modify-write 가 원자적이지 않아 동시 요청이 몰리면 몇 크레딧 샐 수 있다.
 * `MONTHLY_CAP` 이 1,000 이 아니라 950 인 이유의 절반이 그것이고, 나머지 절반은
 * 개발·확인용 호출이 부모의 조사를 굶기지 않게 하는 것이다.
 */

/** 무료 등급 한도. 참고용 — 실제로 막는 값은 아래 `MONTHLY_CAP` 이다. */
export const FREE_TIER_CREDITS = 1_000;

/** 실제 상한. 여유 50 을 남긴다. */
export const MONTHLY_CAP = 950;

/**
 * 한 책이 웹 검색을 쓸 수 있는 횟수.
 *
 * 첫 조사 1회 + 부모가 누르는 재검색 5회. 재검색은 크레딧을 쓰는 **유일한 사용자 조작**이라
 * 책마다 상한을 둔다. 월 예산만으로는 한 부모가 한 책에 수십 번 눌러 전체를 말릴 수 있다.
 */
export const MAX_SEARCHES_PER_BOOK = 6;

/** KST 기준 달. 부모가 보는 달과 카운터가 어긋나면 설명할 수 없다. */
export function currentMonth(now: Date = new Date()): string {
	const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
	return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, "0")}`;
}

const keyFor = (month: string): string => `tavily:${month}`;

export async function spent(env: AppEnv, month = currentMonth()): Promise<number> {
	return Number((await env.SESSIONS.get(keyFor(month))) ?? "0");
}

export const remaining = async (env: AppEnv): Promise<number> =>
	Math.max(0, MONTHLY_CAP - (await spent(env)));

/**
 * 크레딧을 미리 잡는다. **호출 전에** 부른다.
 *
 * 쓰고 나서 세면 초과를 초과한 뒤에 안다. 검색이 실패해도 잡아 둔 크레딧은 돌려주지 않는다 —
 * 실패한 호출에 과금되지 않을 가능성이 높지만 확인할 수 없고, 적게 세는 쪽보다 많이 세는
 * 쪽이 안전하다.
 *
 * @returns 잡았으면 true. 한도에 닿았으면 false — **던지지 않는다.**
 *          웹 검색이 안 되는 것은 실패가 아니라 지금까지의 동작으로 돌아가는 것이다.
 */
export async function reserve(env: AppEnv, credits: number): Promise<boolean> {
	const month = currentMonth();
	const used = await spent(env, month);
	if (used + credits > MONTHLY_CAP) return false;

	// 다음 달로 넘어가면 자연히 사라지도록 넉넉한 TTL. 최장 32일.
	await env.SESSIONS.put(keyFor(month), String(used + credits), {
		expirationTtl: 32 * 24 * 60 * 60,
	});
	return true;
}
