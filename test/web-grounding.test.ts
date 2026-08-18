import { describe, expect, it } from "vitest";
import { buildResearchRequest } from "../src/search/web";
import { buildGenerateRequest } from "../src/ai/generate";
import { buildValidateRequest } from "../src/ai/validate";
import { WEB_SECTION, checkGrounding, evidenceBase, groundedRatio } from "../src/services/grounding";
import type { WebSource } from "../src/search/tavily";

/**
 * 웹 자료를 출제에 쓰는 것 (§docs/tavily-search-plan.md Phase 2·3).
 *
 * Phase 1 은 자료를 모으는 데까지였고 문제 출제에는 쓰이지 않았다. 여기서 두 가지가 바뀐다.
 *  - 조사 지시가 "기억으로 정리" 에서 "자료에서 발췌" 로 (Phase 2)
 *  - 근거 검사가 **웹 자료 기준**으로 좁혀진다 (Phase 3)
 *
 * 두 번째가 핵심이다. 지금까지는 모델이 기억으로 쓴 `[줄거리]` 도 대조 대상이라
 * **자기가 지어낸 줄거리를 근거로 자기 문항을 정당화**할 수 있었다.
 */

const webSource = (over: Partial<WebSource> = {}): WebSource => ({
	url: "https://blog.example.com/a",
	title: "움푹산의 비밀 서평",
	content:
		"거인 크네는 움푹산에 혼자 살았다. 마을 사람들은 크네를 무서워했지만 아이들이 산에서 길을 잃자" +
		" 크네가 아이들을 찾아 마을까지 데려다주었다.",
	score: 0.9,
	...over,
});

const hint = (web: WebSource[] = []) => ({
	title: "움푹산의 비밀",
	author: "천희순",
	publisher: "크레용하우스",
	isbn: "9788955472905",
	bib: [],
	web,
});

const textOf = (request: { instructions: string; prompt: string }) =>
	`${request.instructions}\n${request.prompt}`;

/* ── Phase 2 ─────────────────────────────────────────── */

describe("조사 지시 (Phase 2)", () => {
	it("웹 자료가 있으면 발췌하라고 시킨다", () => {
		const text = textOf(buildResearchRequest("gemini-3.6-flash", hint([webSource()]), false));

		expect(text).toContain("그 안에 적혀 있는 것만");
		expect(text).toContain("당신의 기억으로 채우지 마세요");
		// 자료 원문이 실제로 실렸는지
		expect(text).toContain("거인 크네는 움푹산에 혼자 살았다");
	});

	/**
	 * 자료를 주고도 "당신이 아는 지식으로" 라고 하면 모델이 자료를 배경으로만 보고 기억으로
	 * 답한다. 출판사 책소개에서 실제로 그런 일이 있었다(PR #30).
	 */
	it("웹 자료가 있으면 기억 지시로 가지 않는다", () => {
		const text = textOf(buildResearchRequest("gemini-3.6-flash", hint([webSource()]), false));
		expect(text).not.toContain("당신이 이미 알고 있는 지식만으로");
	});

	it("웹 자료가 없으면 지금 지시 그대로다", () => {
		const recall = textOf(buildResearchRequest("gemini-3.6-flash", hint(), false));
		expect(recall).toContain("당신이 이미 알고 있는 지식만으로");

		const searching = textOf(buildResearchRequest("gemini-3.6-flash", hint(), true));
		expect(searching).toContain("웹 검색으로 공개된 정보를 찾아");
	});

	// 판매 정보뿐인 자료로 줄거리를 지어내면 Phase 1 이 오히려 해가 된다.
	it("자료에 줄거리가 없으면 비우라고 시킨다", () => {
		const text = textOf(buildResearchRequest("gemini-3.6-flash", hint([webSource()]), false));
		expect(text).toContain("판매 정보·홍보 문구뿐이라면");
	});

	// 원문을 통째로 넣으면 프롬프트가 수만 자가 되고 모델이 중간을 흘린다.
	it("자료 수와 길이에 상한이 있다", () => {
		const many = Array.from({ length: 20 }, (_, i) =>
			webSource({ url: `https://a.example/${i}`, content: "가".repeat(5_000) }),
		);
		const text = textOf(buildResearchRequest("gemini-3.6-flash", hint(many), false));

		expect(text).toContain("[자료 6]");
		expect(text).not.toContain("[자료 7]");
		expect(text.length).toBeLessThan(20_000);
	});
});

describe("생성·검증 프롬프트 (Phase 3)", () => {
	const brief = ["[줄거리]", "잎싹은 양계장을 나온다.", "", WEB_SECTION, "[자료 1] 서평", "글"].join("\n");

	it("웹 자료를 출제 근거로 명시한다", () => {
		const text = buildGenerateRequest({
			apiKey: "",
			model: "gpt-5.6-mini",
			brief,
			count: 5,
			language: "ko",
		}).instructions;

		expect(text).toContain("[웹 자료] 는 출제 근거입니다");
		expect(text).toContain("[웹 자료]·[줄거리]·[주요 사건]·[등장인물]");
	});

	// 자료 안에 섞인 판매 안내로 문제를 만들면 책을 읽지 않아도 풀린다.
	it("자료 안의 판매 안내는 근거가 아니라고 못박는다", () => {
		const gen = buildGenerateRequest({
			apiKey: "",
			model: "gpt-5.6-mini",
			brief,
			count: 5,
			language: "ko",
		}).instructions;
		expect(gen).toContain("가격·배송·판매 안내");

		const val = buildValidateRequest({
			apiKey: "",
			model: "gpt-5.6-mini",
			brief,
			questions: [],
			language: "ko",
		}).instructions;
		expect(val).toContain("가격·배송·판매 안내");
	});

	// §7 은 그대로다. 웹 자료가 생겼다고 홍보 문구를 근거로 풀어 줄 이유가 없다.
	it("소개는 여전히 근거가 아니다", () => {
		const text = buildGenerateRequest({
			apiKey: "",
			model: "gpt-5.6-mini",
			brief,
			count: 5,
			language: "ko",
		}).instructions;
		expect(text).toContain("[소개]·[출판사 소개] 는 배경 지식이며 출제 근거가 아닙니다");
	});
});

/* ── Phase 3 — 대조 범위 ─────────────────────────────── */

const BRIEF_WITH_WEB = [
	"[책] 움푹산의 비밀",
	"지은이: 천희순 / 출판사: 크레용하우스",
	"",
	"[소개]",
	"제14회 MBC 창작동화대상을 받은 작가가 다릿돌읽기 시리즈로 펴낸 환상적 동화입니다.",
	"",
	"[줄거리]",
	"거인 크네가 움푹산의 아이들을 구해 낸다.",
	"",
	"[출판사 소개]",
	"다름은 특별함이 될 수 있다는 것을 아이들에게 일깨우는 감동적인 작품입니다.",
	"",
	WEB_SECTION,
	"[자료 1] 움푹산의 비밀 서평",
	"마을 사람들은 크네를 무서워했지만 아이들이 산에서 길을 잃자 크네가 찾아 데려다주었다.",
	"",
	"[출처]",
	"- 서평 https://blog.example.com/a",
].join("\n");

describe("근거 대조 범위", () => {
	it("웹 자료가 있으면 소개를 근거에서 뺀다", () => {
		const base = evidenceBase(BRIEF_WITH_WEB);

		expect(base).toContain("크네가 찾아 데려다주었다");
		expect(base).toContain("거인 크네가 움푹산의 아이들을 구해 낸다");
		// 여기가 핵심 — 홍보 문구는 근거 범위에 없다.
		expect(base).not.toContain("MBC 창작동화대상");
		expect(base).not.toContain("다름은 특별함이 될 수 있다");
	});

	// 지금 잘 되는 책이 갑자기 전부 탈락하면 안 된다.
	it("웹 자료가 없으면 Brief 전체를 그대로 쓴다", () => {
		const noWeb = ["[소개]", "홍보 문구", "", "[줄거리]", "잎싹이 양계장을 나온다."].join("\n");
		expect(evidenceBase(noWeb)).toBe(noWeb);
	});

	/**
	 * `[웹 자료]` 절만 있고 그 아래가 비어 있으면 근거 범위가 여섯 글자가 되어 **모든 문항이
	 * 탈락한다.** 머리글이 아니라 본문이 있는지로 판정해야 이걸 잡는다.
	 */
	it("근거 절에 본문이 없으면 전체로 되돌린다", () => {
		const odd = [WEB_SECTION, "", "[출처]", "- a https://x.example"].join("\n");
		expect(evidenceBase(odd)).toBe(odd);
	});
});

describe("홍보 문구를 근거로 든 문항", () => {
	const question = (evidence: string) => ({
		questionText: "크네는 아이들을 어떻게 했나요?",
		choices: ["구해 주었다", "쫓아냈다", "숨었다", "울었다"],
		correctChoice: 1,
		evidence,
	});

	/**
	 * 이것이 Phase 3 이 막으려는 것이다. `[출판사 소개]` 의 문장을 그대로 인용하면 예전에는
	 * 근거 검사를 통과했다 — Brief 전체와 대조했기 때문이다. §7 이 무력해진다.
	 */
	it("웹 자료가 있으면 탈락한다", () => {
		const out = checkGrounding(
			question("다름은 특별함이 될 수 있다는 것을 아이들에게 일깨우는 감동적인 작품입니다."),
			BRIEF_WITH_WEB,
		);
		expect(out.ok).toBe(false);
		expect(out.reason).toContain("근거");
	});

	it("웹 자료를 인용한 문항은 통과한다", () => {
		const out = checkGrounding(
			question("마을 사람들은 크네를 무서워했지만 아이들이 산에서 길을 잃자 크네가 찾아 데려다주었다."),
			BRIEF_WITH_WEB,
		);
		expect(out.ok).toBe(true);
		expect(out.evidenceRatio).toBeGreaterThan(0.9);
	});

	it("줄거리를 인용한 문항도 통과한다", () => {
		const out = checkGrounding(question("거인 크네가 움푹산의 아이들을 구해 낸다."), BRIEF_WITH_WEB);
		expect(out.ok).toBe(true);
	});

	/*
	 * 문제 문장에 시리즈명 같은 배경 낱말을 쓰는 것 자체는 잘못이 아니다. 금지되는 것은
	 * 그것을 **근거로 삼는** 것이다. 그래서 문제 본문 검사만 넓은 범위를 그대로 쓴다.
	 */
	it("문제 본문은 여전히 Brief 전체와 대조한다", () => {
		const asked = "다릿돌읽기 시리즈 환상적 동화 크네";

		// 소개에만 있는 낱말이므로 좁힌 근거 범위에서는 점수가 떨어진다.
		expect(groundedRatio(asked, BRIEF_WITH_WEB)).toBeGreaterThan(
			groundedRatio(asked, evidenceBase(BRIEF_WITH_WEB)),
		);
		// 그런데도 문항은 통과해야 한다 — 근거는 줄거리에서 왔기 때문이다.
		const out = checkGrounding(
			{
				questionText: "다릿돌읽기 시리즈 환상적 동화에서 크네가",
				choices: ["아이들을 구해 낸다", "산을 떠난다", "숨는다", "운다"],
				correctChoice: 1,
				evidence: "거인 크네가 움푹산의 아이들을 구해 낸다.",
			},
			BRIEF_WITH_WEB,
		);
		expect(out.ok).toBe(true);
	});
});
