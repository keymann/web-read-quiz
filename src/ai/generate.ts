import type { AiProvider } from "./types";
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

evidence 에는 이 문제의 근거가 된 책 속 내용을 적습니다. 근거를 댈 수 없는 문제는 만들지 마세요.`;

export interface GenerateRequest {
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
}

export async function generateQuestions(request: GenerateRequest): Promise<GeneratedQuestion[]> {
	const parts = [
		request.brief,
		"",
		`위 책 정보로 4지선다 문제 ${request.count}개를 만들어 주세요.`,
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
			"확실하게 기억하는 장면만 문제로 만들고, 애매한 세부 사항은 다루지 마세요.",
		);
	}

	const result = await request.provider.structured<{ questions: GeneratedQuestion[] }>(
		request.apiKey,
		{
			model: request.model,
			instructions: INSTRUCTIONS,
			prompt: parts.join("\n"),
			schemaName: "reading_questions",
			schema: QUESTIONS_SCHEMA as unknown as Record<string, unknown>,
		},
		// 20문항은 응답이 길다. 실패한 호출은 과금되지 않으므로 과부하 정도는 넘길 수 있게 둔다.
		{ timeoutMs: 180_000, maxAttempts: 3 },
	);

	return result.questions ?? [];
}
