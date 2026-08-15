import { invalid } from "../utils/response";

/**
 * 키 형식 사전 검사.
 *
 * **화이트리스트로 쓰지 않는다.** 제공자는 키 형식을 예고 없이 바꾼다.
 * (실제로 Google 키는 `AIza…` 39자만 있는 줄 알았는데 `AQ.…` 53자짜리도 발급된다)
 * 형식만 보고 막으면 멀쩡한 키를 거부하고, 부모는 왜 안 되는지 알 길이 없다.
 *
 * 그래서 여기서는 **다른 제공자의 키를 붙여넣은 명백한 실수**만 잡는다.
 * 진짜 유효성은 키를 저장하기 전에 제공자 API 를 호출해서 판정한다.
 */

/** OpenAI 키는 오래 전부터 이 접두사를 쓴다. */
const OPENAI_LIKE = /^sk-/;

/** Google API Key 로 알려진 접두사들. 새 형식이 나오면 여기에 추가한다. */
const GOOGLE_LIKE = /^(AIza|AQ\.)/;

function assertNoWhitespace(apiKey: string): void {
	if (/\s/.test(apiKey)) {
		throw invalid("API Key 에 공백이나 줄바꿈이 섞여 있습니다. 앞뒤를 잘라 다시 붙여넣어 주세요.");
	}
}

export function assertOpenAiKeyShape(apiKey: string): void {
	assertNoWhitespace(apiKey);
	if (GOOGLE_LIKE.test(apiKey)) {
		throw invalid("Google 계열 키로 보입니다. AI 제공자를 Google Gemini 로 바꾼 뒤 저장해 주세요.");
	}
}

export function assertGeminiKeyShape(apiKey: string): void {
	assertNoWhitespace(apiKey);
	if (OPENAI_LIKE.test(apiKey)) {
		throw invalid("OpenAI 키로 보입니다. AI 제공자를 OpenAI 로 바꾼 뒤 저장해 주세요.");
	}
}
