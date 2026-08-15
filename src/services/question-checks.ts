import type { GeneratedQuestion } from "../ai/generate";
import { QUESTION_TYPES } from "../ai/schemas";

/**
 * AI 호출 없이 서버가 하는 사후 검사.
 *
 * 스키마가 못 잡는 것들이다. 여기서 걸러내면 AI 검증(5단계)에 보낼 문항이 줄어 비용도 아낀다.
 * 여기서 탈락한 문항은 곧바로 재생성 대상이 된다.
 */

export interface CheckFailure {
	questionNumber: number;
	reason: string;
}

const TYPES = new Set<string>(QUESTION_TYPES);

/** 비교용으로 공백·문장부호를 털어낸 형태. */
const normalize = (text: string): string =>
	text.toLowerCase().replace(/[\s.,!?"'“”‘’()［］\[\]·…~-]/g, "");

/** 두 문장이 얼마나 겹치는지. 토큰 자카드 유사도. */
function similarity(a: string, b: string): number {
	const tokensOf = (text: string) =>
		new Set(text.toLowerCase().split(/[\s.,!?"'“”‘’()\[\]·…~-]+/).filter((t) => t.length > 1));

	const left = tokensOf(a);
	const right = tokensOf(b);
	if (left.size === 0 || right.size === 0) return 0;

	let shared = 0;
	for (const token of left) if (right.has(token)) shared++;
	return shared / (left.size + right.size - shared);
}

/** 이 이상 겹치면 같은 것을 묻는 문제로 본다(§9-9). */
const DUPLICATE_THRESHOLD = 0.7;

export interface CheckContext {
	/** 이미 확보한 문항의 본문. 중복 검사에 쓴다. */
	accepted: string[];
	/** 책 제목·저자. 문제 본문에 그대로 들어가면 §7 금지 유형에 가깝다. */
	title: string;
	author: string;
}

/** 통과한 문항과 탈락한 문항을 나눠 돌려준다. */
export function screen(
	questions: GeneratedQuestion[],
	context: CheckContext,
): { passed: GeneratedQuestion[]; failed: CheckFailure[] } {
	const passed: GeneratedQuestion[] = [];
	const failed: CheckFailure[] = [];
	const seen = [...context.accepted];

	for (const question of questions) {
		const reason = firstProblem(question, seen, context);
		if (reason) {
			failed.push({ questionNumber: question.questionNumber, reason });
			continue;
		}
		passed.push(question);
		seen.push(question.questionText);
	}

	return { passed, failed };
}

function firstProblem(
	question: GeneratedQuestion,
	seen: string[],
	context: CheckContext,
): string | null {
	const text = question.questionText?.trim() ?? "";
	if (text.length < 5) return "문제 본문이 비어 있거나 너무 짧습니다.";

	const choices = question.choices ?? [];
	if (choices.length !== 4) return "선택지가 4개가 아닙니다.";
	if (choices.some((c) => c.trim() === "")) return "빈 선택지가 있습니다.";

	// 표기만 다르고 같은 말인 선택지는 사실상 복수정답을 만든다(§10-2).
	const normalized = choices.map(normalize);
	if (new Set(normalized).size !== 4) return "서로 같은 선택지가 있습니다.";

	if (!Number.isInteger(question.correctChoice) || question.correctChoice < 1 || question.correctChoice > 4) {
		return "정답 번호가 1~4 범위를 벗어났습니다.";
	}
	if (!TYPES.has(question.questionType)) return "알 수 없는 문제 유형입니다.";
	if (![1, 2, 3].includes(question.difficulty)) return "난이도가 1~3 이 아닙니다.";

	// 근거를 못 대는 문항은 지어냈을 가능성이 높다(§10-10).
	if ((question.evidence ?? "").trim() === "") return "근거가 비어 있습니다.";

	// §7 금지 유형 휴리스틱 — 제목·저자를 그대로 묻는 문제.
	if (context.title && normalize(text).includes(normalize(context.title))) {
		return "문제에 책 제목이 그대로 들어 있습니다.";
	}
	if (context.author && normalize(text).includes(normalize(context.author))) {
		return "문제에 지은이 이름이 들어 있습니다.";
	}

	for (const previous of seen) {
		if (similarity(text, previous) >= DUPLICATE_THRESHOLD) {
			return "이미 만든 다른 문제와 내용이 겹칩니다.";
		}
	}

	return null;
}

/**
 * 정답 위치를 고르게 편다(§9-10).
 *
 * 모델에게 "1번에 몰지 마라"고 부탁하는 대신 서버가 보장한다. 각 문항의 선택지를 재배열해
 * 정답이 1·2·3·4번에 고르게 오도록 만든다. 선택지 내용은 그대로이므로 문제의 의미는 변하지 않는다.
 */
export function balanceAnswerPositions(questions: GeneratedQuestion[]): GeneratedQuestion[] {
	// 1,2,3,4 를 문항 수만큼 반복한 뒤 섞어 목표 위치를 정한다. 20문항이면 정확히 5개씩.
	const targets: number[] = [];
	for (let i = 0; i < questions.length; i++) targets.push((i % 4) + 1);
	for (let i = targets.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[targets[i], targets[j]] = [targets[j]!, targets[i]!];
	}

	return questions.map((question, index) => {
		const target = targets[index]!;
		const answer = question.choices[question.correctChoice - 1]!;
		const others = question.choices.filter((_, i) => i !== question.correctChoice - 1);

		const reordered: string[] = [];
		let cursor = 0;
		for (let slot = 1; slot <= 4; slot++) {
			reordered.push(slot === target ? answer : others[cursor++]!);
		}

		return { ...question, choices: reordered, correctChoice: target };
	});
}

/** 유형이 얼마나 퍼져 있는지. 부모 화면에 보여주고 로그로도 남긴다. */
export const typeDistribution = (questions: GeneratedQuestion[]): Record<string, number> => {
	const counts: Record<string, number> = {};
	for (const question of questions) {
		counts[question.questionType] = (counts[question.questionType] ?? 0) + 1;
	}
	return counts;
};
