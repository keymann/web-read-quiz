import { groundedRatio } from "../services/grounding";
import * as budget from "../services/search-budget";
import type { AppEnv } from "../types";

/**
 * Tavily 웹 검색 (§docs/tavily-search-plan.md).
 *
 * 이 모듈이 있는 이유는 하나다 — **모델의 기억을 실제로 읽은 페이지로 바꾸는 것.**
 *
 * PR #30 에서 측정했다. 모델은 『움푹산의 비밀』의 줄거리를 통째로 지어냈고(거인 크네 이야기를
 * 소년과 한국 표범 이야기로) `found: true` 로 통과했다. 근거 검사는 문항의 근거를 Brief 와
 * 대조하므로, **Brief 자체가 날조되면 그 검사가 날조를 인정한다.**
 *
 * 검증된 출판사 책소개를 프롬프트에 넣어도 부족했다 — 맞는 책으로 돌아오긴 했지만 세부는
 * 여전히 지어냈고, 운영 기본 모델은 그래도 빈손이었다. 책소개 403자는 책을 특정하는 데는
 * 충분해도 줄거리를 대신하지 못한다.
 *
 * 키는 **서비스 공용**이다(알라딘·카카오와 같음). 없으면 조용히 건너뛴다.
 */

export interface WebSource {
	url: string;
	title: string;
	/** 프롬프트와 참고 자료에 쓸 발췌. 원문 전체를 들고 다니지 않는다. */
	content: string;
	/** Tavily 가 매긴 관련도. 상위 몇 건만 프롬프트에 넣을 때 쓴다. */
	score: number;
}

const ENDPOINT = "https://api.tavily.com/search";
const TIMEOUT_MS = 25_000;

/** 깊이별 크레딧. 과금은 **요청 수 × 깊이로만** 정해진다(결과 수·원문은 공짜). */
const CREDITS = { basic: 1, advanced: 2 } as const;
type Depth = keyof typeof CREDITS;

/**
 * 결과 수와 원문은 공짜이므로 넉넉히 받는다. 한국 아동서는 상위 5건이 서점 판매 페이지로
 * 채워지는 일이 흔해 20건이 필요하다.
 */
const MAX_RESULTS = 20;

/** 프롬프트에 넣을 때 소스당 상한. 원문을 통째로 넣으면 모델이 중간을 흘린다. */
export const MAX_EXCERPT = 1_500;

/** 저장할 때의 상한. `MAX_SOURCE_CONTENT` 와 같은 취지다(§6). */
const MAX_STORED = 2_000;

/**
 * 어떤 결과를 "이 책을 다룬 것" 으로 볼지. 제목이 그 글에 얼마나 담겨 있는지로 잰다.
 *
 * `groundedRatio` 를 그대로 쓴다 — 근거 검사와 판본 매칭이 이미 쓰는 계산이고,
 * "찾던 말이 후보 안에 있는가" 라는 여기 필요한 것과 정확히 같다. 같은 계산을 네 번째로
 * 구현하지 않는다.
 *
 * Phase 0 실측(2026-08-18, basic, 결과 20건 기준)으로 0.8 을 골랐다.
 *
 *   마당을 나온 암탉 20 · 우등생 바이러스 12 · 움푹산의 비밀 9 · Dirty Bertie 6
 *   바나나가 뿔났다 0 · (없는 책) 0
 *
 * 단순 문자열 포함으로 셌을 때는 『Dirty Bertie PONG!』이 0 이 나왔다 — 페이지가
 * "Dirty Bertie: Pong!" 로 쓰기 때문이다. 어간 대조는 그것을 넘는다.
 */
const MIN_TITLE_MATCH = 0.8;

/**
 * 이만큼도 안 나오면 "내용이 부족" 으로 보고 한 번 더 시도한다.
 *
 * 실제 책은 6건 이상, 웹에 자료가 없는 책은 0건이었다. 그 사이를 가른다.
 */
const MIN_RELEVANT = 5;

export interface WebHint {
	title: string;
	author: string;
}

/** 한글이 섞였으면 한국책으로 본다. 질의어와 국가를 여기서 가른다. */
const isKorean = (text: string): boolean => /[가-힣]/.test(text);

/**
 * 질의를 책 언어에 맞춘다.
 *
 * Phase 0 에서 영어책(『Dirty Bertie PONG!』)에 한국어 낱말(줄거리·등장인물·독후감)을 붙여
 * 물었더니 **`health.kr` 이 20건 중 8건**을 차지했다. 한국어 낱말이 엉뚱한 한국 사이트를
 * 끌어온 것이다. 영어 질의로 바꾸니 그 오염이 사라졌다.
 *
 * (다만 영어 아동 시리즈물은 질의를 고쳐도 줄거리를 담은 결과가 2/20 에 그쳤다.
 *  이 연동의 이득은 한국책에 있다 — Phase 0 에 기록.)
 */
function buildQuery(hint: WebHint, broad: boolean): { query: string; country?: string } {
	const korean = isKorean(hint.title) || isKorean(hint.author);

	if (!korean) {
		return {
			query: broad
				? `${hint.title} ${hint.author} children's book`
				: `"${hint.title}" ${hint.author} plot summary characters book review`,
		};
	}

	/*
	 * 넓힌 질의는 따옴표를 떼고 낱말도 줄인다.
	 *
	 * 좁은 질의(`"제목" 저자 줄거리 등장인물 독후감`)는 독후감이 많은 책에는 잘 맞지만,
	 * 그런 글이 없는 책에서는 오히려 아무것도 못 찾는다. 실측:
	 *
	 *   움푹산의 비밀   좁게 9건 → 넓게 12건
	 *   바나나가 뿔났다  좁게 0건 → 넓게  1건
	 */
	return {
		query: broad
			? `${hint.title} ${hint.author} 어린이책 내용`
			: `"${hint.title}" ${hint.author} 줄거리 등장인물 독후감`,
		country: "south korea",
	};
}

/** 이 자료가 찾던 그 책을 다루고 있는가. */
export const aboutBook = (source: WebSource, title: string): boolean =>
	groundedRatio(title, `${source.title} ${source.content}`) >= MIN_TITLE_MATCH;

/** 이 책을 실제로 다룬 결과의 수. */
export const relevantCount = (sources: WebSource[], title: string): number =>
	sources.filter((source) => aboutBook(source, title)).length;

/**
 * 이야기를 다루는 글에 나타나는 말.
 *
 * 검색 결과의 절반 이상은 **판매 페이지·도서관 목록**이다(Phase 0 실측: 한국 아동서는 상위
 * 5건이 서점으로 채워진다). 그런 페이지도 제목은 정확히 담고 있어 제목 대조만으로는 걸러지지
 * 않는다. 정가·배송·장바구니만 적힌 발췌를 참고 자료로 올려 두면 부모가 근거를 훑을 때
 * 실제로 읽을 것이 무엇인지 알 수 없다.
 *
 * 낱말을 막는 쪽(정가·배송·적립)이 아니라 **있어야 할 낱말을 요구하는 쪽**으로 짰다. 상거래
 * 문구는 사이트마다 달라 끝이 없지만, 줄거리를 다루는 글은 어느 쪽이든 이 말들을 쓴다.
 */
const PLOT_WORDS = [
	"줄거리",
	"등장인물",
	"주인공",
	"독후감",
	"서평",
	"감상문",
	"이야기",
	"사건",
	"결말",
	"책소개",
	"인물",
	"작품",
	"plot",
	"summary",
	"synopsis",
	"story",
	"character",
	"review",
	"chapter",
	"ending",
] as const;

/**
 * 이 말들 중 **둘 이상**이 나와야 이야기를 다룬 글로 본다.
 *
 * 하나로는 모자란다 — 서점 상세 페이지의 좌우 메뉴에 "책소개" 나 "review" 한 낱말이 걸려
 * 오는 일이 흔하다. 반대로 줄거리를 실제로 적은 글은 주인공·사건·결말을 함께 쓴다.
 */
const MIN_PLOT_WORDS = 2;

/**
 * 이 자료가 책의 내용(줄거리·인물·사건)을 다루고 있는가.
 *
 * 발췌 길이는 보지 않는다. 판매 페이지는 오히려 길고(정가·배송·리뷰 수·판매지수), 짧지만
 * 알찬 도서관 요약도 있다. 길이는 이 판정과 상관이 없다.
 */
export function mentionsPlot(source: WebSource): boolean {
	const haystack = `${source.title} ${source.content}`.toLowerCase();
	const hits = PLOT_WORDS.filter((word) => haystack.includes(word)).length;
	return hits >= MIN_PLOT_WORDS;
}

/**
 * 참고 자료로 올릴 만한 것만 남긴다 — **찾던 책이고, 그 내용을 다루는** 자료.
 *
 * 프롬프트에 싣는 자료는 이걸로 줄이지 않는다. 거기서는 모델이 발췌를 대조해 걸러내고,
 * 판매 페이지의 책소개에서도 줄거리 한 조각은 건질 수 있다. 여기서 거르는 것은 **부모가
 * 눈으로 읽는 목록**이다.
 */
export const plotRelated = (sources: WebSource[], title: string): WebSource[] =>
	sources.filter((source) => aboutBook(source, title) && mentionsPlot(source));

/**
 * 이 키의 월 크레딧이 정말 바닥났다는 신호.
 *
 * - **432 Plan Limit Exceeded** — 무료 등급 월 1,000 을 다 썼다
 * - **433 Pay-As-You-Go Limit Exceeded** — 종량 한도를 넘겼다
 *
 * **429 는 여기 없다.** 그건 분당 레이트리밋(무료 100 RPM)이라 잠시 뒤면 풀린다.
 * 429 로 키를 소진 처리하면 멀쩡한 키를 그 달 내내 버리게 된다.
 */
const EXHAUSTED = new Set([432, 433]);

async function callOnce(
	env: AppEnv,
	hint: WebHint,
	depth: Depth,
	broad: boolean,
): Promise<WebSource[]> {
	const { query, country } = buildQuery(hint, broad);
	return runQuery(env, { query, country, depth });
}

export interface QuerySpec {
	query: string;
	country?: string;
	depth: Depth;
}

/**
 * 질의 하나를 던지고 결과를 정규화해 돌려준다. **크레딧을 실제로 쓰는 곳**이다.
 *
 * 질의를 만드는 일과 분리해 둔다 — 줄거리 검색과 읽기 난이도 검색은 찾는 것이 전혀 달라
 * 질의도 다르지만, 키 회전·예산·오류 처리는 똑같아야 한다.
 */
export async function runQuery(env: AppEnv, spec: QuerySpec): Promise<WebSource[]> {
	const { query, country, depth } = spec;
	const body = JSON.stringify({
		query,
		search_depth: depth,
		max_results: MAX_RESULTS,
		// 원문이 필요하다. 독후감 블로그의 줄거리는 요약이 아니라 본문에 있다.
		include_raw_content: "markdown",
		chunks_per_source: 3,
		// Tavily 가 요약해 주는 answer 는 쓰지 않는다. 그 요약이 또 하나의 기억이 된다 —
		// 우리에게 필요한 것은 근거 검사가 대조할 **원문**이다.
		include_answer: false,
		...(country ? { country } : {}),
	});

	/*
	 * 키가 바닥나면 다음 키로 넘어간다. 무료 등급은 **계정당** 월 1,000 이므로 계정을 여럿
	 * 두면 그만큼 늘어난다.
	 *
	 * 우리 카운터만 믿지 않는 이유: 카운터는 적게 셀 수 있다(KV 경쟁, 이 앱 바깥에서의 사용).
	 * 그러면 남은 달 내내 같은 키로 432 를 받는다. 그래서 **Tavily 가 432 를 주면 그 키를
	 * 소진으로 표시하고** 다음 키로 간다.
	 */
	const exhausted: number[] = [];

	for (;;) {
		// **호출 전에** 잡는다. 쓰고 나서 세면 초과를 초과한 뒤에 안다.
		const slot = await budget.reserve(env, CREDITS[depth], exhausted);
		if (!slot) return [];

		try {
			const response = await fetch(ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${slot.key}` },
				body,
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});

			if (response.ok) {
				const payload = (await response.json()) as { results?: RawResult[] };
				return normalize(payload.results ?? []);
			}

			if (!EXHAUSTED.has(response.status)) return [];

			await budget.markExhausted(env, slot.index);
			exhausted.push(slot.index);
		} catch {
			// 네트워크 오류·타임아웃. 다른 키로 바꿔도 같을 테니 여기서 접는다.
			return [];
		}
	}
}

/**
 * 검색한다. **크레딧을 쓰는 유일한 곳**이다.
 *
 * 기본은 `basic`(1 크레딧)이고, 이 책을 다룬 결과가 모자랄 때만 `advanced` 로 한 번 더 간다.
 *
 * 두 번째 시도에서 **깊이만 올리지 않고 질의도 넓히는** 이유는 실측이다. 깊이만 올리면
 * 자료가 없는 책은 그대로 0건이었다(basic 0 → advanced 0). 질의를 넓혀야 건진다.
 *
 * 실패는 빈 배열로 돌려준다 — 웹 검색이 안 됐다고 조사 전체를 무산시키지 않는다.
 */
export async function search(env: AppEnv, hint: WebHint): Promise<WebSource[]> {
	if (budget.slots(env).length === 0 || hint.title.trim() === "") return [];

	const first = await callOnce(env, hint, "basic", false);
	if (relevantCount(first, hint.title) >= MIN_RELEVANT) return first;

	const second = await callOnce(env, hint, "advanced", true);
	// 더 많이 건진 쪽을 쓴다. 두 번째가 늘 나은 것은 아니다.
	return relevantCount(second, hint.title) > relevantCount(first, hint.title) ? second : first;
}

interface RawResult {
	url?: unknown;
	title?: unknown;
	content?: unknown;
	raw_content?: unknown;
	score?: unknown;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** 여러 줄 공백을 접고 상한을 건다. 원문 마크다운은 표·이미지 링크로 공백이 많다. */
const tidy = (value: string, limit: number): string =>
	value.replace(/\s+/g, " ").trim().slice(0, limit);

export function normalize(results: RawResult[]): WebSource[] {
	const seen = new Set<string>();
	const out: WebSource[] = [];

	for (const raw of results) {
		const url = text(raw.url);
		// http(s) 만 저장한다. 화면에 링크로 붙는 값이다(§26).
		if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
		seen.add(url);

		/*
		 * `content` 는 Tavily 가 뽑은 관련 구간, `raw_content` 는 페이지 전문이다.
		 * 둘을 이어 붙인다 — content 만으로는 줄거리가 잘리는 일이 잦고, raw 만 쓰면
		 * 머리말·광고가 앞을 차지한다. 관련 구간을 앞에 두어 상한에 먼저 들어가게 한다.
		 */
		const excerpt = tidy(`${text(raw.content)} ${text(raw.raw_content)}`, MAX_STORED);
		if (excerpt === "") continue;

		out.push({
			url,
			title: tidy(text(raw.title), 200) || url,
			content: excerpt,
			score: typeof raw.score === "number" ? raw.score : 0,
		});
	}

	// 관련도 높은 것부터. 프롬프트에 상위 몇 건만 넣을 때 이 순서를 그대로 쓴다.
	return out.sort((a, b) => b.score - a.score);
}
