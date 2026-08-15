import { ApiError } from "../utils/response";
import { callOpenAi, type CallOptions } from "./client";

/**
 * OpenAI Responses API + Structured Output 공통 호출부.
 *
 * 자유 형식 텍스트 응답은 쓰지 않는다(§29). 모든 호출은 JSON Schema 를 `strict` 로 걸어
 * 파싱 실패 자체가 일어나지 않게 한다. Vision 식별 · 웹 검색 · 문제 생성 · 문제 검증이
 * 전부 이 함수를 지나간다.
 */

export interface StructuredCall {
	model: string;
	/** Responses API 의 `input`. 문자열이거나 role/content 배열. */
	input: unknown;
	/** 스키마 이름은 영문 소문자·밑줄만. 모델에게 의미 힌트가 되므로 내용을 반영해 짓는다. */
	schemaName: string;
	schema: Record<string, unknown>;
	/** `[{ type: "web_search" }]` 같은 내장 툴. */
	tools?: unknown[];
	instructions?: string;
}

interface ResponsesBody {
	status?: string;
	incomplete_details?: { reason?: string };
	output?: {
		type?: string;
		content?: { type?: string; text?: string }[];
	}[];
}

export async function structured<T>(
	apiKey: string,
	call: StructuredCall,
	options: CallOptions = {},
): Promise<T> {
	const body = await callOpenAi<ResponsesBody>(
		apiKey,
		"/responses",
		{
			method: "POST",
			body: JSON.stringify({
				model: call.model,
				input: call.input,
				...(call.instructions ? { instructions: call.instructions } : {}),
				...(call.tools ? { tools: call.tools } : {}),
				text: {
					format: {
						type: "json_schema",
						name: call.schemaName,
						strict: true,
						schema: call.schema,
					},
				},
			}),
		},
		options,
	);

	if (body.status === "incomplete") {
		const reason = body.incomplete_details?.reason ?? "unknown";
		throw new ApiError("ai_failed", `AI 응답이 중간에 끊겼습니다. (${reason})`, 502);
	}

	const text = extractOutputText(body);
	if (text === null) throw new ApiError("ai_failed", "AI 응답을 읽을 수 없습니다.", 502);

	try {
		return JSON.parse(text) as T;
	} catch {
		// strict 스키마를 걸었으므로 정상 경로에서는 오지 않는다. 오면 모델·API 쪽 문제다.
		console.error("structured output parse failed", text.slice(0, 200));
		throw new ApiError("ai_failed", "AI 응답 형식이 올바르지 않습니다.", 502);
	}
}

/**
 * `output` 배열에서 첫 번째 `output_text` 를 꺼낸다.
 * 툴을 쓰면 앞쪽에 `web_search_call` 같은 항목이 섞이므로 message 만 골라야 한다.
 */
function extractOutputText(body: ResponsesBody): string | null {
	for (const item of body.output ?? []) {
		if (item.type !== undefined && item.type !== "message") continue;
		for (const part of item.content ?? []) {
			if (part.type === "output_text" && typeof part.text === "string") return part.text;
		}
	}
	return null;
}
