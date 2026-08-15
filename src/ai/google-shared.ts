import { toBase64 } from "../utils/base64";
import { ApiError } from "../utils/response";
import { parseStructured } from "./http";
import type { StructuredRequest } from "./types";

/**
 * Gemini API 와 Vertex AI 가 공유하는 부분.
 *
 * 두 서비스는 인증 방식과 엔드포인트가 다를 뿐 `generateContent` 의 요청·응답 형태는 같다.
 * 스키마 방언 변환과 본문 조립을 여기 모아 두 구현이 어긋나지 않게 한다.
 */

/**
 * JSON Schema → Google `responseSchema` (OpenAPI 3.0 방언).
 *
 * 차이가 세 가지 있다.
 *  - type 이 대문자 열거형이다 (OBJECT · STRING · …)
 *  - `additionalProperties` 를 받지 않는다
 *  - `propertyOrdering` 으로 필드 순서를 고정할 수 있다. 순서를 고정하면 출력 품질이 안정된다.
 */
export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(schema)) {
		if (key === "additionalProperties") continue;

		if (key === "type" && typeof value === "string") {
			out.type = value.toUpperCase();
			continue;
		}

		if (key === "properties" && value !== null && typeof value === "object") {
			const properties: Record<string, unknown> = {};
			for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
				properties[name] = toGeminiSchema(child as Record<string, unknown>);
			}
			out.properties = properties;
			out.propertyOrdering = Object.keys(properties);
			continue;
		}

		if (key === "items" && value !== null && typeof value === "object") {
			out.items = toGeminiSchema(value as Record<string, unknown>);
			continue;
		}

		out[key] = value;
	}

	return out;
}

export interface GenerateContentResponse {
	candidates?: {
		content?: { parts?: { text?: string }[] };
		finishReason?: string;
		/** 그라운딩(구글 검색)을 썼을 때 실제로 참고한 페이지들. */
		groundingMetadata?: {
			groundingChunks?: { web?: { uri?: string; title?: string } }[];
		};
	}[];
	promptFeedback?: { blockReason?: string };
}

/**
 * 그라운딩으로 실제 참고한 페이지.
 *
 * 모델에게 `sources` 를 채우라고 시켜 두었지만 자주 비워서 보낸다. 그럴 때도 응답에는
 * `groundingMetadata` 가 붙어 오므로, 무엇을 보고 답했는지는 여기서 확실히 알 수 있다.
 * 부모가 "이 정보 어디서 왔나" 를 확인할 수 있어야 문제를 검수할 수 있다.
 */
export function extractGroundingSources(
	body: GenerateContentResponse,
): { url: string; title: string }[] {
	const chunks = body.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
	const seen = new Set<string>();
	const sources: { url: string; title: string }[] = [];

	for (const chunk of chunks) {
		const url = chunk.web?.uri;
		if (!url?.startsWith("http") || seen.has(url)) continue;
		seen.add(url);
		sources.push({ url, title: chunk.web?.title ?? url });
	}

	return sources;
}

/** `generateContent` 요청 본문. 두 서비스가 같은 모양을 받는다. */
export function buildGenerateContentBody(request: StructuredRequest): Record<string, unknown> {
	const parts: unknown[] = [{ text: request.prompt }];
	if (request.image) {
		parts.push({
			inline_data: { mime_type: request.image.mime, data: toBase64(request.image.bytes) },
		});
	}

	return {
		contents: [{ role: "user", parts }],
		...(request.instructions
			? { systemInstruction: { parts: [{ text: request.instructions }] } }
			: {}),
		...(request.webSearch ? { tools: [{ googleSearch: {} }] } : {}),
		generationConfig: {
			responseMimeType: "application/json",
			responseSchema: toGeminiSchema(request.schema),
			// Gemini 3.x 는 추론(thinking) 토큰이 출력 예산을 함께 쓴다. 기본값에 맡기면
			// 20문항처럼 긴 응답이 MAX_TOKENS 로 잘린다. 넉넉히 잡아 둔다.
			maxOutputTokens: 32_768,
		},
	};
}

export function parseGenerateContentResponse<T>(
	provider: string,
	body: GenerateContentResponse,
): T {
	const blocked = body.promptFeedback?.blockReason;
	if (blocked) {
		throw new ApiError("ai_failed", `AI 가 요청을 차단했습니다. (${blocked})`, 502);
	}

	const candidate = body.candidates?.[0];
	if (candidate?.finishReason === "MAX_TOKENS") {
		throw new ApiError("ai_failed", "AI 응답이 길이 제한으로 끊겼습니다.", 502);
	}

	const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? null;
	return parseStructured<T>(provider, text);
}

/* ── 모델 목록 필터·정렬 ─────────────────────────────── */

/** 문제 생성에 쓸 수 없는 계열. */
const EXCLUDED_SUBSTRINGS = [
	"embedding",
	"aqa",
	"imagen",
	"veo",
	"tts",
	"native-audio",
	"live",
	"image",
	"learnlm",
	"gemma",
	"medlm",
	// 영상 이해 전용 EAP 모델. 목록에는 뜨지만 이 서비스에는 쓸 수 없다.
	"video-understanding",
	"-eap",
	"customtools",
	// 아래 셋은 실제 계정 목록에 떠서 확인한 것들이다. 문제 생성용 텍스트 모델이 아니다.
	"computer-use", // 화면 조작 에이전트
	"robotics", // 로봇 제어
	"omni", // 실시간 멀티모달 대화
];

/**
 * 세대. 앞에 있을수록 우선. 더 구체적인 접두사를 먼저 둔다.
 *
 * 최신인 3.7 이 아니라 3.6 이 먼저다. 실측: 무료 등급 키에서 3.7-flash 는 사실상 상시
 * `429 RESOURCE_EXHAUSTED` 라 매 호출이 헛걸음 한 번과 모델 교체를 치른다. 한 세대 아래는
 * 잘 나가고 품질 차이도 이 용도에서는 드러나지 않는다. 유료 키라면 설정에서 바꾸면 된다.
 */
const FAMILY_PREFERENCE = [
	"gemini-3.6",
	"gemini-3.7",
	"gemini-3.5",
	"gemini-3.1",
	"gemini-3",
	"gemini-2.5",
	"gemini-2.0",
];

export function isUsableGeminiModel(id: string): boolean {
	if (!id.startsWith("gemini-")) return false;
	return !EXCLUDED_SUBSTRINGS.some((word) => id.includes(word));
}

export function rankGeminiModel(id: string): number {
	const family = FAMILY_PREFERENCE.find((prefix) => id.startsWith(prefix));
	if (family === undefined) return 999;

	const suffix = id.slice(family.length);
	// 무료 티어에서 쓸 수 있는 flash 를 기본으로 삼는다. pro 는 비싸므로 뒤로 민다.
	const variant =
		suffix === "-flash" ? 0 : suffix === "-flash-lite" ? 1 : suffix.includes("pro") ? 3 : 2;

	// preview·exp 는 예고 없이 바뀌므로 같은 조건이면 뒤로.
	const unstable = /preview|exp|eap/.test(id) ? 5 : 0;

	return FAMILY_PREFERENCE.indexOf(family) * 10 + variant + unstable;
}

export const sortGeminiModels = (ids: string[]): string[] =>
	ids.sort((a, b) => rankGeminiModel(a) - rankGeminiModel(b) || a.length - b.length || a.localeCompare(b));
