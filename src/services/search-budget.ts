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

/**
 * 무료 등급 한도(계정당). 참고용 — 실제로 **막는** 값은 아래 `MONTHLY_CAP` 이다.
 *
 * 2026-08-22 에 Tavily `GET /usage` 로 네 계정을 모두 확인했다. 넷 다 `current_plan:
 * "Researcher"` · `plan_limit: 1000` 이었다.
 */
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

/* ── 실제 잔량은 Tavily 에게 묻는다 ──────────────────── */

/**
 * 부모에게 보여줄 잔량은 **우리 카운터가 아니라 Tavily 가 아는 값**이다.
 *
 * 카운터는 막는 데 쓰는 값이라 실제와 어긋날 수밖에 없다. KV 는 read-modify-write 가
 * 원자적이지 않아 새고, 이 앱 바깥에서 같은 키를 쓰면 아예 세지 못한다. 실패한 호출에
 * 잡아 둔 크레딧도 돌려주지 않는다 — 많이 세는 쪽이 안전하기 때문이다.
 *
 * 그 값을 화면에 "남은 크레딧" 이라고 적으면 부모가 대시보드에서 보는 숫자와 다르다.
 * 2026-08-22 실측: 우리 표시는 한도가 3,800 이라고 했지만 실제 한도는 네 계정 × 1,000 =
 * **4,000** 이었고, 그때까지 실제로 쓴 것은 101 크레딧이었다.
 *
 * `GET /usage` 는 **크레딧을 쓰지 않는다.** 같은 키로 세 번 불러 `usage` 가 1 에서
 * 움직이지 않는 것을 확인했다.
 */
const USAGE_ENDPOINT = "https://api.tavily.com/usage";

/** 한 계정에 묻는 시간. 실측 1.0~1.6초라 여유를 두고 끊는다. */
const USAGE_TIMEOUT_MS = 4_000;

/**
 * 조회 결과를 들고 있는 시간과, **다시 물어볼 때가 됐다고 보는 시간.**
 *
 * 책 화면을 열 때마다 물으면 키 수만큼 왕복이 붙는다 — 실측 1.5초다. 그래서 화면은
 * **들고 있던 값을 바로 내주고**, 그것이 5분보다 묵었으면 응답과 무관하게 뒤에서 다시 묻는다.
 * 크레딧은 초 단위로 변하는 값이 아니라 몇 분 묵은 숫자로도 충분하다.
 *
 * 들고 있는 시간을 훨씬 길게 두는 이유: 그 사이에는 부모가 기다리는 일이 없다. 짧게 두면
 * 만료된 순간에 걸린 부모가 카운터로 짐작한 숫자를 보게 된다.
 */
const USAGE_CACHE_KEY = "tavily:usage";
const USAGE_TTL = 24 * 60 * 60;

/**
 * 이만큼 묵으면 다시 묻는다.
 *
 * 5분이었다. 그러면 책 화면을 꾸준히 열어 볼 때 **하루 최대 288번 KV 에 쓴다** — 무료 등급
 * 하루 쓰기 1,000회의 3할이다. 그 한도로 앱이 멈춘 적이 있어(2026-08-23) 여유를 크게 둔다.
 *
 * 30분 묵은 크레딧 숫자로도 부모가 판단하는 데는 충분하다. 이 값이 정확해야 하는 자리는
 * 화면이 아니라 예산 가드(`reserve`)이고, 그쪽은 우리 카운터를 본다.
 */
export const USAGE_STALE_MS = 30 * 60 * 1000;

export interface Usage {
	/** 이달 쓴 크레딧. */
	used: number;
	/** 이달 쓸 수 있는 크레딧. */
	limit: number;
	/** Tavily 에게 물어 얻은 값인지. false 면 우리 카운터로 짐작한 값이다. */
	measured: boolean;
}

/** 캐시에 적어 두는 모양. 언제 물어본 값인지 함께 남긴다. */
interface CachedUsage extends Usage {
	/** 물어본 시각(ms). 이것으로 다시 물을 때를 정한다. */
	at: number;
}

interface UsageResponse {
	account?: { plan_usage?: unknown; plan_limit?: unknown };
}

const num = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

/** 키 하나가 딸린 계정의 사용량. 못 물어보면 null. */
async function askUsage(key: string): Promise<{ used: number; limit: number } | null> {
	try {
		const response = await fetch(USAGE_ENDPOINT, {
			headers: { authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
		});
		if (!response.ok) return null;

		const payload = (await response.json()) as UsageResponse;
		const used = num(payload.account?.plan_usage);
		const limit = num(payload.account?.plan_limit);
		return used === null || limit === null ? null : { used, limit };
	} catch {
		return null;
	}
}

/** 우리 카운터로 짐작한 값. Tavily 에게 못 물어봤을 때 쓴다. */
async function guessed(env: AppEnv): Promise<Usage> {
	return { used: await spent(env), limit: slots(env).length * MONTHLY_CAP, measured: false };
}

const readCache = async (env: AppEnv): Promise<CachedUsage | null> => {
	const raw = await env.SESSIONS.get(USAGE_CACHE_KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as CachedUsage;
		return num(parsed.used) === null || num(parsed.limit) === null ? null : parsed;
	} catch {
		return null;
	}
};

/**
 * 실제로 물어 캐시에 적는다. **부모를 기다리게 하지 않는 자리에서 부른다**(`waitUntil`).
 *
 * 키마다 딸린 계정에 나란히 묻고 합친다. 못 물어본 키는 우리 카운터로 메운다 — 한 키가
 * 응답하지 않는다고 전체 숫자를 감추면 부모는 얼마 남았는지 알 수 없다.
 *
 * 키를 **같은 계정에서 두 개 발급하면 그 계정이 두 번 세어진다.** 응답에 계정을 가릴 값이
 * 없어 여기서는 걸러낼 수 없다. 키마다 다른 계정을 쓰는 것이 이 설계의 전제다(§8-1).
 */
export async function refreshUsage(env: AppEnv, now = Date.now()): Promise<Usage> {
	const configured = slots(env);
	if (configured.length === 0) return { used: 0, limit: 0, measured: false };

	const month = currentMonth();
	const perKey = await Promise.all(
		configured.map(async (slot) => {
			const asked = await askUsage(slot.key);
			if (asked) return { ...asked, measured: true };
			return { used: await spentOn(env, slot.index, month), limit: MONTHLY_CAP, measured: false };
		}),
	);

	const total: Usage = {
		used: perKey.reduce((sum, one) => sum + one.used, 0),
		limit: perKey.reduce((sum, one) => sum + one.limit, 0),
		// 하나라도 짐작이 섞였으면 measured 가 아니다. 화면이 그 사실을 적을 수 있어야 한다.
		measured: perKey.every((one) => one.measured),
	};

	await env.SESSIONS.put(USAGE_CACHE_KEY, JSON.stringify({ ...total, at: now }), {
		expirationTtl: USAGE_TTL,
	});
	return total;
}

/**
 * 화면에 보여줄 잔량. **외부를 부르지 않는다.**
 *
 * 들고 있던 값을 그대로 내주고, 다시 물을 때가 됐는지를 `stale` 로 알린다. 부르는 쪽이
 * 그것을 보고 `waitUntil` 로 갱신을 맡기면 부모는 기다리지 않는다.
 */
export async function usage(
	env: AppEnv,
	now = Date.now(),
): Promise<Usage & { stale: boolean }> {
	if (slots(env).length === 0) return { used: 0, limit: 0, measured: false, stale: false };

	const cached = await readCache(env);
	if (cached) {
		return { ...cached, stale: now - cached.at > USAGE_STALE_MS };
	}
	// 아직 한 번도 못 물어봤다. 짐작한 값을 내주고 갱신을 맡긴다.
	return { ...(await guessed(env)), stale: true };
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
