import { groundedRatio } from "../services/grounding";
import * as budget from "../services/search-budget";
import * as tavily from "./tavily";
import type { AppEnv } from "../types";

/**
 * 영문책의 읽기 난이도(AR·Lexile)를 **전용 질의로** 찾아온다.
 *
 * 왜 따로 찾는가 — 예전에는 줄거리 조사 프롬프트에 필드만 얹어 두었다. 그런데 그 조사가
 * 던지는 질의는 `"제목" 저자 plot summary characters book review` 라, 등급을 싣고 있는
 * 페이지(AR BookFinder · Lexile Hub · Scholastic · 서점 상세)가 결과에 **아예 들어오지
 * 않는다.** 모델은 볼 자료가 없으니 정직하게 빈칸을 돌려줬다. 실측 획득률 0/2.
 *
 * 그래서 등급을 겨냥한 질의를 한 번 더 던지고, **모델을 거치지 않고 정규식으로 뽑는다.**
 * 등급은 페이지에 `ATOS Book Level: 4.4` 처럼 이름표를 달고 적혀 있어, 읽어내는 데
 * 추론이 필요 없다. AI 를 태우지 않으니 비용도 안 들고 지어낼 여지도 없다.
 */

export interface ReadingLevel {
	/** ATOS 북 레벨. `4.4` 꼴의 문자열. 못 찾으면 빈 문자열. */
	arLevel: string;
	arPoints: string;
	arInterestLevel: string;
	/** 접두어를 포함한 렉사일 지수(`680L` · `AD540L`). */
	lexile: string;
	/** 값을 실제로 뽑아낸 페이지. 참고 자료로 남긴다. */
	sources: { url: string; title: string }[];
}

export const EMPTY: ReadingLevel = {
	arLevel: "",
	arPoints: "",
	arInterestLevel: "",
	lexile: "",
	sources: [],
};

/**
 * 이 결과가 정말 그 책을 다룬 것인지.
 *
 * 등급을 엉뚱한 책에서 가져오는 것이 이 기능의 가장 큰 위험이다. 같은 시리즈의 다른 권,
 * 같은 제목의 다른 책이 흔하다. 줄거리라면 조금 어긋나도 부모가 읽고 알아채지만, 숫자는
 * 그냥 믿게 된다. 그래서 줄거리 검색(0.8)보다 **더 엄격하게** 건다.
 */
const MIN_TITLE_MATCH = 0.9;

/* ── 뽑아내기 ────────────────────────────────────────── */

/**
 * 렉사일은 `680L` 처럼 숫자 뒤에 L 이 붙고, 앞에 뜻을 담은 접두어가 올 수 있다.
 *   AD 성인지도 · NC 비통상 · HL 흥미도높음 · IG 삽화 · GN 그래픽노블 · BR 초보
 */
/*
 * 이름표와 값 사이에는 낱말이 낀다 — `Lexile measure : 680L`, `Lexile® Measure 680L`.
 * 그래서 사이를 "숫자가 아닌 것" 으로 두되 **게으르게** 넘긴다. 숫자까지 삼켜 버리면
 * 정작 지수를 놓친다.
 */
const LEXILE_LABELLED = /lexile[^0-9]{0,40}?((?:AD|NC|HL|IG|GN|BR)?\s?\d{2,4}\s?L)\b/i;
/** 소문자로 적는 페이지도 있다(`br200l`). 대소문자를 가리지 않고 받아 표기를 통일한다. */
const LEXILE_BARE = /\b((?:AD|NC|HL|IG|GN|BR)?\d{2,4}L)\b/i;

/**
 * 이름표가 붙은 것을 먼저 찾는다.
 *
 * 이름표 없이 `\d+L` 만 찾으면 아무 페이지의 `500L`(용량·길이)이 걸린다. 그래서 맨몸
 * 패턴은 그 페이지가 렉사일을 말하고 있을 때만 쓴다.
 */
function findLexile(text: string): string {
	const labelled = LEXILE_LABELLED.exec(text);
	if (labelled?.[1]) return labelled[1].replace(/\s+/g, "").toUpperCase();

	if (!/lexile/i.test(text)) return "";
	const bare = LEXILE_BARE.exec(text);
	return bare?.[1] ? bare[1].toUpperCase() : "";
}

const ATOS =
	/(?:ATOS(?:\s*Book)?\s*Level|AR\s*(?:Book\s*)?Level|Book\s*Level|Reading\s*Level)\s*[:\-–]?\s*(\d{1,2}\.\d)/i;

/**
 * 실존 범위를 벗어난 값은 버린다. 페이지의 다른 숫자를 잘못 물었다는 뜻이다.
 * ATOS 는 학년.개월이라 20 을 넘지 않고, 포인트는 두꺼운 책도 200 을 넘지 않는다.
 */
const inRange = (raw: string, max: number): string => {
	const value = Number.parseFloat(raw);
	return Number.isFinite(value) && value > 0 && value <= max ? raw : "";
};

function findArLevel(text: string): string {
	const m = ATOS.exec(text);
	return m?.[1] ? inRange(m[1], 20) : "";
}

/** `AR Points: 5.0`. 이름표 없는 `Points` 는 그 페이지가 AR 을 말할 때만 본다. */
const AR_POINTS_LABELLED = /\bAR\s*(?:Points?|Pts?\.?)\s*[:\-–]?\s*(\d{1,3}(?:\.\d)?)/i;
const POINTS_BARE = /\bPoints?\s*[:\-–]?\s*(\d{1,3}\.\d)\b/i;

function findArPoints(text: string): string {
	const labelled = AR_POINTS_LABELLED.exec(text);
	if (labelled?.[1]) return inRange(labelled[1], 200);

	if (!/ATOS|Accelerated\s*Reader|AR\s*Level/i.test(text)) return "";
	const bare = POINTS_BARE.exec(text);
	return bare?.[1] ? inRange(bare[1], 200) : "";
}

/**
 * 흥미 수준은 코드로도(`MG`) 말로도(`Middle Grades`) 적힌다. 둘 다 받는다.
 * `MG+` 를 `MG` 보다 먼저 봐야 한다 — 앞을 먼저 맞히면 `+` 를 잃는다.
 */
const INTEREST_PHRASES: [RegExp, string][] = [
	[/Middle\s*Grades?\s*Plus/i, "MG+"],
	[/Upper\s*Grades?/i, "UG"],
	[/Middle\s*Grades?/i, "MG"],
	[/Lower\s*Grades?/i, "LG"],
];
const INTEREST_CODE = /Interest\s*Level\s*[:\-–]?\s*(?:[^()\n]{0,30}\(\s*)?(MG\+|LG|MG|UG)\b/i;
const INTEREST_LINE = /Interest\s*Level\s*[:\-–]?\s*([^\n|;]{0,40})/i;

function findArInterest(text: string): string {
	const code = INTEREST_CODE.exec(text);
	if (code?.[1]) return code[1].toUpperCase();

	const line = INTEREST_LINE.exec(text);
	if (!line?.[1]) return "";
	for (const [pattern, value] of INTEREST_PHRASES) {
		if (pattern.test(line[1])) return value;
	}
	return "";
}

/** 한 페이지에서 뽑아낸 값. */
export function extract(text: string): Omit<ReadingLevel, "sources"> {
	return {
		arLevel: findArLevel(text),
		arPoints: findArPoints(text),
		arInterestLevel: findArInterest(text),
		lexile: findLexile(text),
	};
}

/* ── 여러 페이지의 값 모으기 ──────────────────────────── */

type Field = keyof Omit<ReadingLevel, "sources">;
const FIELDS: Field[] = ["arLevel", "arPoints", "arInterestLevel", "lexile"];

/**
 * 항목마다 **가장 많은 페이지가 같다고 말한 값**을 고른다.
 *
 * 한 페이지만 말해도 받아들인다. 여러 곳이 일치할 때까지 기다리면, 자료가 얇은 책은
 * 영영 빈칸이 된다 — 그것이 지금 고치려는 문제다. 대신 표가 갈리면 다수를 따르고,
 * 같으면 관련도가 높은 페이지를 따른다.
 */
export function vote(
    perSource: { value: Omit<ReadingLevel, "sources">; url: string; title: string }[],
): ReadingLevel {
	const out: ReadingLevel = { ...EMPTY, sources: [] };
	const used = new Map<string, { url: string; title: string }>();

	for (const field of FIELDS) {
		const tally = new Map<string, number>();
		const firstSeen = new Map<string, { url: string; title: string }>();

		for (const s of perSource) {
			const value = s.value[field];
			if (value === "") continue;
			tally.set(value, (tally.get(value) ?? 0) + 1);
			if (!firstSeen.has(value)) firstSeen.set(value, { url: s.url, title: s.title });
		}
		if (tally.size === 0) continue;

		// 표가 같으면 먼저 나온 것 — perSource 는 관련도 순이다.
		let best = "";
		let bestCount = 0;
		for (const [value, count] of tally) {
			if (count > bestCount) {
				best = value;
				bestCount = count;
			}
		}

		out[field] = best;
		const source = firstSeen.get(best);
		if (source) used.set(source.url, source);
	}

	out.sources = [...used.values()];
	return out;
}

/* ── 조회 ────────────────────────────────────────────── */

export interface Hint {
	title: string;
	author: string;
}

/**
 * 등급을 싣고 있는 페이지를 겨냥한 질의.
 *
 * 낱말이 곧 그 페이지들이 쓰는 이름표다 — `ATOS book level`·`Lexile measure`·`AR points`.
 * 이렇게 물으면 AR BookFinder·Lexile Hub·Scholastic·서점 상세가 올라온다.
 */
export const buildQuery = (hint: Hint): string =>
	`"${hint.title}" ${hint.author} ATOS book level Lexile measure AR points interest level`.trim();

/**
 * 찾는다. 크레딧 1(basic)을 쓴다.
 *
 * 실패는 빈 값으로 돌려준다 — 등급을 못 찾았다고 조사 전체를 무산시키지 않는다.
 */
export async function lookup(env: AppEnv, hint: Hint): Promise<ReadingLevel> {
	if (budget.slots(env).length === 0 || hint.title.trim() === "") return EMPTY;

	const results = await tavily.runQuery(env, { query: buildQuery(hint), depth: "basic" });

	const perSource = results
		// 그 책을 다룬 페이지만 본다. 숫자는 부모가 그냥 믿으므로 엄격하게 거른다.
		.filter((s) => groundedRatio(hint.title, `${s.title} ${s.content}`) >= MIN_TITLE_MATCH)
		.map((s) => ({ value: extract(`${s.title} ${s.content}`), url: s.url, title: s.title }));

	return vote(perSource);
}
