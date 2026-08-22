import type { GeneratedQuestion } from "./generate";
import { VALIDATION_SCHEMA } from "./schemas";
import type { QuestionLanguage } from "../types";
import type { AiProvider, StructuredRequest } from "./types";

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
10. **제공된 책 정보에 적혀 있는 내용인가?** (당신이 이 책을 안다고 생각하더라도, 아래 정보에
    없는 장면·인물·대사를 다루면 탈락입니다. 당신의 기억도 틀릴 수 있습니다)

판정 규칙:
- 하나라도 어긋나면 valid 를 false 로 두고 reason 에 무엇이 문제인지 한 문장으로 적습니다.
- score 는 독서 확인 문제로서의 품질을 0~100 으로 매깁니다.
- readRequired 는 책을 읽지 않고도 상식이나 검색으로 맞힐 수 있으면 false 입니다.
- **명확히 어긋날 때만 탈락시킵니다.** 복수 정답·책 내용과의 불일치·검색으로 답할 수 있는
  문제는 그대로 탈락입니다. 그러나 표현이 조금 아쉬운 정도, 더 좋은 문제가 있었을 것 같은
  정도로는 탈락시키지 마세요. 최종 검수는 부모가 문항을 하나하나 읽으며 합니다.
- 근거(evidence)가 제공된 정보에 실제로 있는지는 **서버가 이미 글자로 대조해 통과시킨
  것**입니다. 같은 문장을 다시 의심하지 말고, 문제와 정답이 그 근거와 어긋나는지만 보세요.
- 4번을 볼 때 **[소개]·[출판사 소개] 만으로 답이 나오는 문제는 탈락**입니다. 그건 홍보 문구라
  책을 읽지 않아도 읽을 수 있습니다. 근거가 [웹 자료]·[줄거리]·[주요 사건]·[등장인물] 에
  있어야 합니다.
- **[웹 자료] 가 있으면 근거는 거기서 확인되어야 합니다.** 이 항목은 독후감·서평처럼 책 내용을
  다룬 실제 페이지에서 온 글이므로 근거로 인정합니다. 다만 그 안의 가격·배송·판매 안내를
  근거로 쓴 문제는 탈락입니다 — 책을 읽지 않아도 답할 수 있습니다.
- 10번은 **문제와 정답**을 봅니다. 근거에 적힌 사실과 문제·정답이 어긋나거나, 근거가 다루지
  않는 장면·인물을 문제가 끌어들이면 valid=false 입니다. 근거 문장 자체가 제공된 정보에
  있는지는 서버가 이미 확인했으니 다시 따지지 마세요.
  오답 선택지는 지어내도 되므로 이 기준에서 제외합니다.`;

export interface ValidateRequest {
	provider: AiProvider;
	apiKey: string;
	model: string;
	brief: string;
	questions: GeneratedQuestion[];
	/** 문제를 낸 언어. 판정 사유(reason)를 같은 언어로 받으려는 게 아니라, 언어가 섞였는지 보게 한다. */
	language?: QuestionLanguage;
}

export function buildValidateRequest(request: ValidateRequest): StructuredRequest {
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

	return {
		model: request.model,
		instructions: INSTRUCTIONS,
		prompt: [
			request.brief,
			"",
			"다음 문제들을 검수해 주세요.",
			// 언어가 섞인 문항은 아이가 읽지 못한다. 사후검사로는 잡기 어려워 검수자에게 맡긴다.
			request.language === "ko"
				? "이 문제들은 한국어로 출제되어야 합니다. 영어가 섞여 있으면 탈락시키세요."
				: "이 문제들은 영어로 출제되어야 합니다. 한국어가 섞여 있으면 탈락시키세요.",
			"reason 은 한국어로 적습니다.",
			"",
			rendered,
		].join("\n"),
		schemaName: "question_validation",
		schema: VALIDATION_SCHEMA as unknown as Record<string, unknown>,
	};
}

export async function validateQuestions(request: ValidateRequest): Promise<Verdict[]> {
	const result = await request.provider.structured<{ results: Verdict[] }>(
		request.apiKey,
		buildValidateRequest(request),
		{ timeoutMs: 180_000, maxAttempts: 3 },
	);

	return result.results ?? [];
}
