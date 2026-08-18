import type { AppEnv } from "../types";

/**
 * Tavily 월 크레딧 예산 (§docs/tavily-search-plan.md §4.4).
 *
 * 무료 등급은 **계정당 월 1,000 크레딧**이고, 그것은 조용히 넘길 수 있는 숫자다. 넘기면 그 달의
 * 남은 기간 동안 모든 부모의 웹 검색이 죽는다. 그래서 어댑터보다 이것이 먼저 있어야 한다.
 *
 * 키가 여럿이면 **각각이 독립된 풀**이다. 하나가 바닥나면 다음 키로 넘어간다.
 *
 * KV 는 read-modify-write 가 원자적이지 않아 동시 요청이 몰리면 몇 크레딧 샐 수 있다.
 * `MONTHLY_CAP` 이 1,000 이 아니라 950 인 이유의 절반이 그것이고, 나머지 절반은
 * 개발·확인용 호출이 부모의 조사를 굶기지 않게 하는 것이다.
 */

/** 무료 등급 한도(계정당). 참고용 — 실제로 막는 값은 아래 `MONTHLY_CAP` 이다. */
export const FREE_TIER_CREDITS = 1_000;

/** 키 하나가 한 달에 쓸 수 있는 크레딧. 여유 50 을 남긴다. */
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

export interface Slot {
	/** 1부터. `TAVILY_API_KEY`(1) · `TAVILY_API_KEY2`(2) … */
	index: number;
	key: string;
}

/**
 * 설정된 키를 **번호 순서대로** 모은다. 이 순서가 곧 사용 순서다.
 *
 * 중간이 비어 있어도(2 는 없고 3 은 있음) 있는 것만 추린다 — 키를 지웠을 때 뒤엣것이
 * 통째로 안 쓰이면 설명할 수 없다.
 */
export function slots(env: AppEnv): Slot[] {
	const raw = [env.TAVILY_API_KEY, env.TAVILY_API_KEY2, env.TAVILY_API_KEY3, env.TAVILY_API_KEY4];
	return raw
		.map((key, position) => ({ index: position + 1, key: (key ?? "").trim() }))
		.filter((slot) => slot.key !== "");
}

/**
 * 1번 키만 예전 키 이름을 쓴다.
 *
 * 이 연동을 붙일 때 카운터가 `tavily:2026-08` 이었다. 키를 여럿으로 늘리면서 이름을 바꾸면
 * 그 달에 이미 쓴 크레딧이 0 으로 보여 한도를 넘긴다. 1번만 옛 이름을 유지한다.
 */
const keyFor = (month: string, index: number): string =>
	index === 1 ? `tavily:${month}` : `tavily:${month}:${index}`;

/** 이 키가 이달 쓴 크레딧. */
export async function spentOn(env: AppEnv, index: number, month = currentMonth()): Promise<number> {
	return Number((await env.SESSIONS.get(keyFor(month, index))) ?? "0");
}

/** 설정된 키 전부가 이달 쓴 크레딧의 합. */
export async function spent(env: AppEnv, month = currentMonth()): Promise<number> {
	const used = await Promise.all(slots(env).map((slot) => spentOn(env, slot.index, month)));
	return used.reduce((total, value) => total + value, 0);
}

/** 설정된 키 전부에 남은 크레딧의 합. 화면에 그대로 보여준다. */
export async function remaining(env: AppEnv): Promise<number> {
	const month = currentMonth();
	const left = await Promise.all(
		slots(env).map(async (slot) => Math.max(0, MONTHLY_CAP - (await spentOn(env, slot.index, month)))),
	);
	return left.reduce((total, value) => total + value, 0);
}

// 다음 달로 넘어가면 자연히 사라지도록 넉넉한 TTL. 최장 32일.
const TTL_SECONDS = 32 * 24 * 60 * 60;

/**
 * 크레딧을 미리 잡는다. **호출 전에** 부른다.
 *
 * 쓰고 나서 세면 초과를 초과한 뒤에 안다. 검색이 실패해도 잡아 둔 크레딧은 돌려주지 않는다 —
 * 실패한 호출에 과금되지 않을 가능성이 높지만 확인할 수 없고, 적게 세는 쪽보다 많이 세는
 * 쪽이 안전하다.
 *
 * @param skip 이미 소진이 확인된 키 번호. 그 키는 건너뛴다.
 * @returns 쓸 키. 전부 바닥났으면 null — **던지지 않는다.** 웹 검색이 안 되는 것은
 *          실패가 아니라 지금까지의 동작으로 돌아가는 것이다.
 */
export async function reserve(
	env: AppEnv,
	credits: number,
	skip: number[] = [],
): Promise<Slot | null> {
	const month = currentMonth();

	for (const slot of slots(env)) {
		if (skip.includes(slot.index)) continue;

		const used = await spentOn(env, slot.index, month);
		if (used + credits > MONTHLY_CAP) continue;

		await env.SESSIONS.put(keyFor(month, slot.index), String(used + credits), {
			expirationTtl: TTL_SECONDS,
		});
		return slot;
	}

	return null;
}

/**
 * 이 키가 정말로 바닥났다고 표시한다.
 *
 * Tavily 가 **432 (Plan Limit Exceeded)** 를 주면 우리 카운터가 뭐라 하든 그 키는 끝이다.
 * 카운터는 적게 셀 수 있다 — KV 경쟁으로 새거나, 이 앱 바깥에서 같은 키를 썼거나.
 * 그때 카운터만 믿으면 남은 달 내내 같은 키로 432 를 받는다.
 */
export async function markExhausted(env: AppEnv, index: number): Promise<void> {
	await env.SESSIONS.put(keyFor(currentMonth(), index), String(MONTHLY_CAP), {
		expirationTtl: TTL_SECONDS,
	});
}
