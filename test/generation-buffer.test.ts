import { describe, expect, it } from "vitest";
import { applyVerdicts, withBuffer } from "../src/services/generation";
import { makeQuestions, verdictsFor } from "./helpers";

/**
 * 1라운드에 여유분을 얹는 것과, 남은 문항을 탈락으로 세지 않는 것(§성능 분석).
 *
 * 실측(Phase 3, n=5): 1라운드 탈락이 2,0,1,0,2 였고 5회 중 3회가 2라운드로 넘어갔다.
 * 라운드 하나는 AI 호출 2회라 시간이 거의 두 배가 된다. 문항을 몇 개 더 요청하는 비용은
 * 출력 토큰뿐이다 — 요청 크기는 문항 수와 무관하다(실측 4.5KB 고정).
 */
describe("여유분", () => {
	it("필요한 수의 20% 를 더 요청한다", () => {
		// 실측 최대 탈락이 10문항에서 2였다. 그만큼은 흡수해야 한다.
		expect(withBuffer(10)).toBe(12);
		expect(withBuffer(20)).toBe(24);
		expect(withBuffer(5)).toBe(6);
	});

	// 1문항이 필요한 라운드에서도 하나는 더 받아야 한다. 그러지 않으면 또 한 라운드가 돈다.
	it("적은 수에서도 최소 1개는 더 요청한다", () => {
		expect(withBuffer(1)).toBe(2);
		expect(withBuffer(2)).toBe(3);
	});

	// 끝없이 늘리면 출력이 길어져 오히려 느려지고 MAX_TOKENS 위험도 커진다.
	it("여유분에 상한이 있다", () => {
		expect(withBuffer(100)).toBe(105);
	});
});

describe("자리가 없어 못 쓴 문항", () => {
	/**
	 * 검수를 통과했는데 자리가 찬 문항은 **탈락이 아니다.**
	 *
	 * 탈락으로 섞으면 두 군데가 틀어진다.
	 *  - 다음 라운드 프롬프트가 멀쩡한 문항을 "반복하지 마라" 목록에 올린다
	 *  - 부모에게 보여줄 안내가 통과 수를 실제보다 적게 센다
	 */
	it("탈락이 아니라 남은 것으로 센다", () => {
		const questions = makeQuestions(12);
		const result = applyVerdicts(questions, verdictsFor(questions).results as never, 10);

		expect(result.accepted).toHaveLength(10);
		expect(result.surplus).toBe(2);
		// 여기가 핵심 — 멀쩡한 문항이 탈락 목록에 없어야 한다
		expect(result.rejected).toEqual([]);
	});

	it("정말 탈락한 것과 남은 것을 함께 가른다", () => {
		const questions = makeQuestions(12);
		// 앞 3개만 통과시킨다 → 통과 3, 탈락 9, 남은 것 0
		const verdicts = questions.map((q, i) => ({
			questionNumber: q.questionNumber,
			valid: i < 3,
			score: i < 3 ? 90 : 20,
			reason: i < 3 ? "" : "책 내용과 맞지 않습니다.",
			readRequired: true,
		}));

		const result = applyVerdicts(questions, verdicts as never, 10);
		expect(result.accepted).toHaveLength(3);
		expect(result.rejected).toHaveLength(9);
		expect(result.surplus).toBe(0);
	});
});
