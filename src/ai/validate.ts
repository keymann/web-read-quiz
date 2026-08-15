import type { GeneratedQuestion } from "./generate";
import { VALIDATION_SCHEMA } from "./schemas";
import type { AiProvider } from "./types";

/** 파이프라인 5단계 — 생성된 문제를 한 번의 호출로 일괄 검증한다(§10·§28). */

export interface Verdict {
	questionNumber: number;
	valid: boolean;
	score: number;
	reason: string;
	readRequired: boolean;
}

/** 요구사항 §10 의 10개 기준. */
const INSTRUCTIONS = `당신은 초등학생 독서 문제를 검수하는 편집자입니다.
제공된 책 정보와 문제들을 보고, 문제마다 아래 10가지 기준으로 판정하세요.

1. 정답이 하나만 존재하는가?
2. 선택지 중 복수 정답이 존재하지 않는가?
3. 책 내용과 일치하는가?
4. 인터넷 검색만으로 쉽게 답할 수 있는가? (그렇다면 탈락)
5. 책을 실제로 읽어야 알 수 있는 내용인가?
6. 질문이 명확한가?
7. 초등학생이 이해할 수 있는가?
8. 다른 문제와 중복되지 않는가?
9. 오답이 명확하게 구분되는가?
10. 책에 존재하지 않는 내용을 지어내지 않았는가?

판정 규칙:
- 하나라도 어긋나면 valid 를 false 로 두고 reason 에 무엇이 문제인지 한 문장으로 적습니다.
- score 는 독서 확인 문제로서의 품질을 0~100 으로 매깁니다.
- readRequired 는 책을 읽지 않고도 상식이나 검색으로 맞힐 수 있으면 false 입니다.
- **엄격하게 보세요.** 애매하면 통과시키지 말고 탈락시킵니다. 문제는 다시 만들면 됩니다.`;

export interface ValidateRequest {
	provider: AiProvider;
	apiKey: string;
	model: string;
	brief: string;
	questions: GeneratedQuestion[];
}

export async function validateQuestions(request: ValidateRequest): Promise<Verdict[]> {
	const rendered = request.questions
		.map((q) =>
			[
				`[${q.questionNumber}] ${q.questionText}`,
				...q.choices.map((choice, i) => `  ${i + 1}) ${choice}`),
				`  정답: ${q.correctChoice} / 유형: ${q.questionType} / 난이도: ${q.difficulty}`,
				`  근거: ${q.evidence}`,
			].join("\n"),
		)
		.join("\n\n");

	const result = await request.provider.structured<{ results: Verdict[] }>(
		request.apiKey,
		{
			model: request.model,
			instructions: INSTRUCTIONS,
			prompt: [request.brief, "", "다음 문제들을 검수해 주세요.", "", rendered].join("\n"),
			schemaName: "question_validation",
			schema: VALIDATION_SCHEMA as unknown as Record<string, unknown>,
		},
		{ timeoutMs: 180_000, maxAttempts: 3 },
	);

	return result.results ?? [];
}
