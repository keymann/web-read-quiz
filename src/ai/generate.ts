import type { QuestionLanguage } from "../types";
import type { AiProvider, StructuredRequest } from "./types";
import { QUESTIONS_SCHEMA } from "./schemas";

/** 파이프라인 4·6단계 — 4지선다 문제 생성(§7·§9). */

export interface GeneratedQuestion {
	questionNumber: number;
	questionText: string;
	choices: string[];
	correctChoice: number;
	questionType: string;
	difficulty: number;
	explanation: string;
	evidence: string;
	readRequired: boolean;
}

/** 요구사항 §9 의 12개 조건을 그대로 옮긴 것. 문구를 임의로 바꾸지 말 것. */
const INSTRUCTIONS = `당신은 초등학생 독서교육 전문 출제자입니다.
제공된 책 정보를 기반으로 책을 실제로 읽었는지 확인할 수 있는
4지선다형 독서 문제를 생성하세요.

조건:
1. 모든 문제는 4개의 선택지를 가진다.
2. 정답은 반드시 하나만 존재해야 한다.
3. 책을 읽지 않고 책 제목이나 인터넷 검색만으로 답할 수 있는 문제는 만들지 않는다.
4. 책의 구체적인 사건과 등장인물의 행동을 적극적으로 활용한다.
5. 사건의 순서, 원인과 결과, 특정 장면의 세부 내용을 활용한다.
6. 단순한 줄거리 요약 문제를 최소화한다.
7. 오답도 책의 내용과 관련성이 있어야 한다.
8. 초등학생이 이해할 수 있는 문장으로 작성한다.
9. 동일한 내용을 반복하는 문제를 만들지 않는다.
10. 정답 위치를 1번에 편중시키지 않는다.
11. 문제 난이도를 Easy/Normal/Hard 로 분산한다.
12. 실제 책을 읽어야 풀 수 있는 문제인지 스스로 검증한다.

만들지 말아야 할 문제:
- 책 제목을 묻는 문제
- 작가를 묻는 문제
- 주인공 이름만 묻는 문제
- 인터넷 검색만으로 쉽게 답할 수 있는 문제
- 책 소개문만 읽어도 답할 수 있는 문제

문제 유형을 다음과 같이 적절하게 분산한다.
EVENT(사건) · CHARACTER(등장인물) · DETAIL(세부 내용) · SEQUENCE(사건 순서)
CAUSE_EFFECT(원인과 결과) · ACTION(행동) · EMOTION(감정) · INFERENCE(추론)

**가장 중요한 규칙 — 주어진 정보 안에서만 출제합니다.**
- 아래에 제공된 책 정보(줄거리·등장인물·주요 사건·소개)에 **적혀 있는 내용만** 문제로 만듭니다.
- 그 책을 알고 있더라도 **제공된 정보에 없는 장면·인물·대사는 쓰지 마세요.** 기억은 틀릴 수 있습니다.
- evidence 에는 근거가 된 부분을 **제공된 정보의 표현 그대로** 옮겨 적습니다.
  바꿔 쓰지 말고, 해당 문장을 그대로 인용하세요.
- **evidence 는 출력 언어와 무관하게 제공된 정보에 적힌 언어 그대로 인용합니다.**
  문제와 선택지가 영어여도 evidence 는 원문(한국어)을 그대로 옮깁니다. 번역하지 마세요.
- 근거를 그대로 옮길 수 없는 문제는 **만들지 마세요.** 개수를 채우는 것보다 지어내지 않는 것이 중요합니다.
- 오답 선택지는 그럴듯하게 지어내도 됩니다. 이 규칙은 **문제·정답·근거**에만 적용됩니다.`;

export interface GenerateRequest {
	/** 서버가 직접 호출할 때만 필요하다. 브라우저 릴레이에서는 조립만 한다. */
	provider: AiProvider;
	apiKey: string;
	model: string;
	/** 서버가 조립한 Book Brief(파이프라인 3단계 결과). */
	brief: string;
	/** 이번 호출에서 만들 문항 수. */
	count: number;
	/** 이미 확보한 문항의 요약. 중복을 피하게 한다. */
	existing?: string[];
	/** 앞서 폐기된 문항과 그 사유. 같은 실수를 반복하지 않게 한다. */
	rejected?: { questionText: string; reason: string }[];
	/** 근거가 웹 검색이 아니라 모델 지식뿐인 경우. 더 보수적으로 출제하게 한다. */
	briefIsUnverified?: boolean;
	/** 문제를 낼 언어. 책이 한국어여도 문제는 영어로 낼 수 있다. */
	language?: QuestionLanguage;
}

/**
 * 출력 언어 지시.
 *
 * 프롬프트와 책 정보는 한국어로 주고 **출력만** 영어로 받는다. 지시를 통째로 영어로 바꾸면
 * §9 의 12개 조건 문구를 옮겨야 하는데, 그 문구는 요구사항에서 그대로 온 것이라 건드리지
 * 않는 편이 안전하다.
 *
 * 어느 필드가 아이 눈에 보이는지를 짚어 준다. 그러지 않으면 문제만 영어로 쓰고 선택지는
 * 한국어로 남기는 식으로 섞인다.
 */
const LANGUAGE_RULE: Record<QuestionLanguage, string> = {
	en: [
		"출력 언어: **영어**.",
		"questionText · choices · explanation · evidence 를 모두 자연스러운 영어로 씁니다.",
		"초등학생이 읽을 영어이므로 쉬운 낱말과 짧은 문장을 씁니다.",
		"등장인물 이름은 책에 쓰인 표기를 로마자로 옮겨 일관되게 씁니다.",
	].join(" "),
	ko: "출력 언어: **한국어**. questionText · choices · explanation · evidence 를 모두 한국어로 씁니다.",
};

export function buildGenerateRequest(request: GenerateRequest): StructuredRequest {
	const parts = [
		request.brief,
		"",
		`위 책 정보로 4지선다 문제 ${request.count}개를 만들어 주세요.`,
		LANGUAGE_RULE[request.language ?? "en"],
	];

	// 분배는 서버가 사후에 강제하지 못하는 부분(유형·난이도)만 프롬프트로 요구한다.
	// 문항 수는 부모가 정하므로 비율로 환산한다.
	if (request.count >= 8) {
		const perType = Math.max(1, Math.floor(request.count / 8));
		const easy = Math.round(request.count * 0.3);
		const hard = Math.round(request.count * 0.3);
		parts.push(
			`유형은 8종을 최소 ${perType}문항씩 배분하고,` +
				` 난이도는 Easy ${easy} · Normal ${request.count - easy - hard} · Hard ${hard} 정도로 나눠 주세요.`,
		);
	}

	if (request.existing?.length) {
		parts.push(
			"",
			"다음 문제들은 이미 만들어 두었습니다. 내용이 겹치지 않게 **다른 장면·다른 인물**을 다뤄 주세요:",
			...request.existing.map((text, i) => `${i + 1}. ${text}`),
		);
	}

	if (request.rejected?.length) {
		parts.push(
			"",
			"아래 문제들은 검수에서 탈락했습니다. 같은 문제를 반복하지 마세요:",
			...request.rejected.map((r) => `- "${r.questionText}" → ${r.reason}`),
		);
	}

	if (request.briefIsUnverified) {
		parts.push(
			"",
			"주의: 위 책 정보는 웹 검색으로 확인한 것이 아니라 기억에 의존한 내용입니다.",
			"그러므로 **위에 적힌 것 밖으로 나가지 마세요.** 기억을 덧붙이면 틀린 내용이 됩니다.",
		);
	}

	// 지어낸 문항은 서버가 근거를 Brief 와 글자로 대조해 걸러낸다. 그 사실을 미리 알려
	// 모델이 "적당히 그럴듯하게" 쓰는 대신 실제로 인용하게 만든다.
	parts.push(
		"",
		"서버가 evidence 를 위 책 정보와 대조합니다. 위에 없는 내용을 근거로 적으면 그 문제는 버려집니다.",
	);

	return {
		model: request.model,
		instructions: INSTRUCTIONS,
		prompt: parts.join("\n"),
		schemaName: "reading_questions",
		schema: QUESTIONS_SCHEMA as unknown as Record<string, unknown>,
	};
}

export async function generateQuestions(request: GenerateRequest): Promise<GeneratedQuestion[]> {
	const result = await request.provider.structured<{ questions: GeneratedQuestion[] }>(
		request.apiKey,
		buildGenerateRequest(request),
		// 20문항은 응답이 길다. 실패한 호출은 과금되지 않으므로 과부하 정도는 넘길 수 있게 둔다.
		{ timeoutMs: 180_000, maxAttempts: 3 },
	);

	return result.questions ?? [];
}
