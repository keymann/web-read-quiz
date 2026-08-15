import { ApiError } from "../utils/response";
import {
	buildGenerateContentBody,
	isUsableGeminiModel,
	parseGenerateContentResponse,
	sortGeminiModels,
	type GenerateContentResponse,
} from "./google-shared";
import { logAiError, requestJson } from "./http";
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

/**
 * 429 의 의미가 웹 검색 여부에 따라 완전히 다르다.
 *
 * 무료 등급 키는 일반 호출은 200 인데 `google_search` 툴을 붙이는 순간 429 RESOURCE_EXHAUSTED 가
 * 돌아온다(실측 확인). 그라운딩 쿼터가 0 이라 기다려도 풀리지 않는다. 이걸 "잠시 후 재시도"로
 * 안내하면 부모는 영원히 되지 않는 일을 계속 시도하게 된다.
 */
interface ModelListResponse {
	models?: { name?: string; supportedGenerationMethods?: string[] }[];
}

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

export const gemini: AiProvider = {
	name: "gemini",
	label: "Google Gemini",
	consoleUrl: "https://aistudio.google.com/apikey",

	assertKeyFormat: assertGeminiKeyShape,

	keyLabel: (apiKey) => `끝 4자리 ${apiKey.slice(-4)}`,

	async listModels(apiKey) {
		const body = await call<ModelListResponse>(apiKey, "/models?pageSize=200", { method: "GET" }, {
			timeoutMs: 15_000,
		});

		const ids = (body.models ?? [])
			// 목록에는 임베딩·음성 전용도 섞여 온다. generateContent 를 지원하는 것만 남긴다.
			.filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
			.map((m) => (m.name ?? "").replace(/^models\//, ""))
			.filter(isUsableGeminiModel);

		return sortGeminiModels(ids);
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
		const body = await call<GenerateContentResponse>(
			apiKey,
			`/models/${encodeURIComponent(request.model)}:generateContent`,
			{ method: "POST", body: JSON.stringify(buildGenerateContentBody(request)) },
			options,
			request.webSearch === true,
		);

		return parseGenerateContentResponse<T>("gemini", body);
	},
};
