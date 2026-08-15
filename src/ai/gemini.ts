import { toBase64 } from "../utils/base64";
import { ApiError } from "../utils/response";
import { logAiError, parseStructured, requestJson } from "./http";
import { assertGeminiKeyShape } from "./keyshape";
import type { AiProvider, CallOptions, Classify, StructuredRequest } from "./types";

/**
 * Gemini 구현 — generateContent + responseSchema.
 *
 * OpenAI 와 달리 **결제 수단 없이도** 이미지 입력과 구조화 출력을 쓸 수 있다.
 * 부모가 부담 없이 시작할 수 있는 경로다.
 *
 * 다만 무료 등급에는 두 가지 제약이 있다(실측 확인).
 *  - **Google 검색 그라운딩은 쓸 수 없다.** 같은 키·같은 모델로 일반 호출은 200 인데
 *    `google_search` 툴을 붙이면 429 RESOURCE_EXHAUSTED 가 돌아온다. 결제 계정을 연결해야 열린다.
 *  - 입력이 Google 제품 개선에 사용될 수 있고 Flash 계열만 열려 있다.
 * 두 가지 모두 설정 화면에서 안내한다.
 */

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

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
	// 영상 이해 전용 EAP 모델. 목록에는 뜨지만 이 서비스에는 쓸 수 없다.
	"video-understanding",
	"-eap",
	"customtools",
];

/** 세대. 앞에 있을수록 우선. 더 구체적인 접두사를 먼저 둔다. */
const FAMILY_PREFERENCE = [
	"gemini-3.7",
	"gemini-3.6",
	"gemini-3.5",
	"gemini-3.1",
	"gemini-3",
	"gemini-2.5",
	"gemini-2.0",
];

interface ModelListResponse {
	models?: { name?: string; supportedGenerationMethods?: string[] }[];
}

interface GenerateContentResponse {
	candidates?: {
		content?: { parts?: { text?: string }[] };
		finishReason?: string;
	}[];
	promptFeedback?: { blockReason?: string };
}

/**
 * 429 의 의미가 웹 검색 여부에 따라 완전히 다르다.
 *
 * 무료 등급 키는 일반 호출은 200 인데 `google_search` 툴을 붙이는 순간 429 RESOURCE_EXHAUSTED 가
 * 돌아온다(실측 확인). 그라운딩 쿼터가 0 이라 기다려도 풀리지 않는다. 이걸 "잠시 후 재시도"로
 * 안내하면 부모는 영원히 되지 않는 일을 계속 시도하게 된다.
 */
const makeClassify = (webSearch: boolean): Classify => (status, body) => {
	const error = (body as { error?: { message?: string; status?: string } } | null)?.error;
	const message = error?.message ?? "";
	const code = error?.status ?? "";

	logAiError("gemini", status, code, message);

	if (status === 429 && webSearch) {
		return {
			error: new ApiError(
				"search_unavailable",
				"이 Gemini 키로는 웹 검색을 쓸 수 없습니다. 무료 등급에서는 Google 검색 그라운딩이 제공되지 않습니다.",
				400,
			),
			retryable: false,
		};
	}

	// Google 이 **요청을 보낸 서버의 위치**를 보고 막는 경우다. 키·모델과 무관하다.
	// Cloudflare Worker 에서 나가는 요청이 여기에 걸린다(실측 확인). 같은 키로 로컬에서는
	// 잘 되기 때문에, 이 사실을 알려주지 않으면 키를 몇 번이고 다시 넣어 보게 된다.
	if (status === 400 && code === "FAILED_PRECONDITION" && message.includes("location")) {
		return {
			error: new ApiError(
				"region_blocked",
				"이 서버가 있는 지역에서는 Gemini API 를 쓸 수 없습니다. Google 이 요청 위치를 기준으로 막습니다. " +
					"OpenAI 키를 등록해 주세요. (같은 키라도 개인 PC 의 로컬 실행 환경에서는 동작합니다)",
				400,
			),
			retryable: false,
		};
	}

	// Gemini 는 잘못된 키도 400 INVALID_ARGUMENT 로 준다. 상태 코드만으로는 구분되지 않는다.
	if (status === 400 && (message.includes("API key") || message.includes("API_KEY"))) {
		return {
			error: new ApiError("invalid", "Gemini API Key 가 올바르지 않습니다. 다시 확인해 주세요.", 400),
			retryable: false,
		};
	}

	if (status === 401 || status === 403) {
		return {
			error: new ApiError(
				"invalid",
				"이 Gemini API Key 로는 사용할 수 없는 요청입니다. 키와 프로젝트 설정을 확인해 주세요.",
				400,
			),
			retryable: false,
		};
	}

	if (status === 429) {
		// 무료 티어의 429 는 대부분 분당 요청 수 초과다. 잠시 뒤 다시 보내면 통과한다.
		return {
			error: new ApiError(
				"ai_failed",
				"Gemini 호출량 한도에 걸렸습니다. 무료 한도라면 잠시 후 다시 시도해 주세요.",
				502,
			),
			retryable: true,
		};
	}

	if (status === 404) {
		return {
			error: new ApiError("ai_failed", "선택한 Gemini 모델을 사용할 수 없습니다. 설정에서 다른 모델을 골라 주세요.", 502),
			retryable: false,
		};
	}

	if (status === 400) {
		return {
			error: new ApiError("ai_failed", `AI 요청이 거부되었습니다. (${code || "bad_request"})`, 502),
			retryable: false,
		};
	}

	return {
		error: new ApiError("ai_failed", "AI 호출에 실패했습니다.", 502),
		// 503 UNAVAILABLE 은 모델 과부하로 자주 나온다. 재시도할 가치가 있다.
		retryable: status >= 500,
	};
};

const call = <T>(
	apiKey: string,
	path: string,
	init: RequestInit,
	options?: CallOptions,
	webSearch = false,
) =>
	requestJson<T>(
		`${BASE_URL}${path}`,
		{
			...init,
			// 키를 쿼리스트링이 아니라 헤더로 보낸다. URL 은 로그·프록시에 남기 쉽다.
			headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json", ...init.headers },
		},
		makeClassify(webSearch),
		options,
	);

/**
 * JSON Schema → Gemini `responseSchema` (OpenAPI 3.0 방언).
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

function rank(id: string): number {
	const family = FAMILY_PREFERENCE.find((prefix) => id.startsWith(prefix));
	if (family === undefined) return 999;

	const suffix = id.slice(family.length);
	// 무료 티어에서 쓸 수 있는 flash 를 기본으로 삼는다. pro 는 유료 전용이라 뒤로 민다.
	const variant = suffix === "-flash"
		? 0
		: suffix === "-flash-lite"
			? 1
			: suffix.includes("pro")
				? 3
				: 2;

	// preview·exp 는 예고 없이 바뀌므로 같은 조건이면 뒤로.
	const unstable = /preview|exp|eap/.test(id) ? 5 : 0;

	return FAMILY_PREFERENCE.indexOf(family) * 10 + variant + unstable;
}

function isUsable(model: { name?: string; supportedGenerationMethods?: string[] }): boolean {
	const id = (model.name ?? "").replace(/^models\//, "");
	if (!id.startsWith("gemini-")) return false;

	// 목록에는 임베딩·음성 전용도 섞여 온다. generateContent 를 지원하는 것만 남긴다.
	const methods = model.supportedGenerationMethods;
	if (methods && !methods.includes("generateContent")) return false;

	return !EXCLUDED_SUBSTRINGS.some((word) => id.includes(word));
}

export const gemini: AiProvider = {
	name: "gemini",
	label: "Google Gemini",
	consoleUrl: "https://aistudio.google.com/apikey",

	assertKeyFormat: assertGeminiKeyShape,

	async listModels(apiKey) {
		const body = await call<ModelListResponse>(apiKey, "/models?pageSize=200", { method: "GET" }, {
			timeoutMs: 15_000,
		});

		return (body.models ?? [])
			.filter(isUsable)
			.map((m) => (m.name ?? "").replace(/^models\//, ""))
			.sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b));
	},

	async probe(apiKey, model) {
		try {
			await call(
				apiKey,
				`/models/${encodeURIComponent(model)}:generateContent`,
				{
					method: "POST",
					body: JSON.stringify({
						contents: [{ role: "user", parts: [{ text: "ping" }] }],
						generationConfig: { maxOutputTokens: 16 },
					}),
				},
				{ timeoutMs: 20_000, maxAttempts: 1 },
			);
			return null;
		} catch (err) {
			return err instanceof Error ? err.message : "AI 호출을 확인하지 못했습니다.";
		}
	},

	async structured<T>(apiKey: string, request: StructuredRequest, options?: CallOptions): Promise<T> {
		const parts: unknown[] = [{ text: request.prompt }];
		if (request.image) {
			parts.push({
				inline_data: { mime_type: request.image.mime, data: toBase64(request.image.bytes) },
			});
		}

		const body = await call<GenerateContentResponse>(
			apiKey,
			`/models/${encodeURIComponent(request.model)}:generateContent`,
			{
				method: "POST",
				body: JSON.stringify({
					contents: [{ role: "user", parts }],
					...(request.instructions
						? { systemInstruction: { parts: [{ text: request.instructions }] } }
						: {}),
					...(request.webSearch ? { tools: [{ google_search: {} }] } : {}),
					generationConfig: {
						responseMimeType: "application/json",
						responseSchema: toGeminiSchema(request.schema),
						// Gemini 3.x 는 추론(thinking) 토큰이 출력 예산을 함께 쓴다. 기본값에 맡기면
						// 20문항처럼 긴 응답이 MAX_TOKENS 로 잘린다. 넉넉히 잡아 둔다.
						maxOutputTokens: 32_768,
					},
				}),
			},
			options,
			request.webSearch === true,
		);

		const blocked = body.promptFeedback?.blockReason;
		if (blocked) {
			throw new ApiError("ai_failed", `AI 가 요청을 차단했습니다. (${blocked})`, 502);
		}

		const candidate = body.candidates?.[0];
		if (candidate?.finishReason === "MAX_TOKENS") {
			throw new ApiError("ai_failed", "AI 응답이 길이 제한으로 끊겼습니다.", 502);
		}

		const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? null;
		return parseStructured<T>("gemini", text);
	},
};
