import { ApiError } from "../utils/response";
import {
	buildGenerateContentBody,
	isUsableGeminiModel,
	parseGenerateContentResponse,
	sortGeminiModels,
	type GenerateContentResponse,
} from "./google-shared";
import { logAiError, requestJson } from "./http";
import { getAccessToken, parseServiceAccount, type ServiceAccount } from "./googleauth";
import type { AiProvider, CallOptions, Classify, StructuredRequest } from "./types";

/**
 * Vertex AI 구현 — 같은 Gemini 모델을 GCP 를 통해 부른다.
 *
 * 왜 필요한가: AI Studio 의 Gemini API(`generativelanguage.googleapis.com`)는 **요청을 보낸
 * 서버의 위치**를 보고 막는다. Cloudflare Worker 에서 부르면 `FAILED_PRECONDITION: User location
 * is not supported` 가 돌아온다(실측). 같은 키로 개인 PC 에서는 잘 된다.
 *
 * Vertex AI 는 호출자 위치를 보지 않는다. 대신 API Key 를 받지 않고 **GCP 서비스 계정**으로
 * 인증한다. 그래서 부모가 넣는 값이 API Key 한 줄이 아니라 서비스 계정 JSON 파일 전체다.
 */

/**
 * 리전.
 *
 * `global` 은 구글이 알아서 가용 리전으로 보내 준다. 모델이 특정 리전에만 있어서 404 가 나는
 * 상황을 피할 수 있어 기본값으로 쓴다. `global` 일 때는 호스트에 리전 접두사를 붙이지 않는다.
 */
const LOCATION = "global";

const host = (location: string): string =>
	location === "global"
		? "https://aiplatform.googleapis.com"
		: `https://${location}-aiplatform.googleapis.com`;

const classify: Classify = (status, body) => {
	// Vertex 는 오류를 배열로 감싸 보낼 때가 있다.
	const raw = Array.isArray(body) ? body[0] : body;
	const error = (raw as { error?: { message?: string; status?: string } } | null)?.error;
	const message = error?.message ?? "";
	const code = error?.status ?? "";

	logAiError("vertex", status, code, message);

	if (status === 401) {
		return {
			error: new ApiError("invalid", "서비스 계정 인증이 만료되었거나 올바르지 않습니다.", 400),
			retryable: false,
		};
	}

	if (status === 403) {
		// 권한 부족과 API 미사용이 모두 403 으로 온다. 둘 다 대시보드에서 할 일이라 함께 안내한다.
		return {
			error: new ApiError(
				"invalid",
				"이 서비스 계정에 권한이 없거나 프로젝트에서 Vertex AI API 가 켜져 있지 않습니다. " +
					"서비스 계정에 'Vertex AI User' 역할을 주고, Vertex AI API 를 사용 설정해 주세요.",
				400,
			),
			retryable: false,
		};
	}

	if (status === 404) {
		return {
			error: new ApiError(
				"ai_failed",
				"선택한 모델을 이 프로젝트에서 쓸 수 없습니다. 설정에서 다른 모델을 골라 주세요.",
				502,
			),
			retryable: false,
		};
	}

	if (status === 429) {
		return {
			error: new ApiError("ai_failed", "Vertex AI 호출량 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요.", 502),
			retryable: true,
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

async function call<T>(
	account: ServiceAccount,
	url: string,
	init: RequestInit,
	options?: CallOptions,
): Promise<T> {
	const token = await getAccessToken(account);
	return requestJson<T>(
		url,
		{
			...init,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				...init.headers,
			},
		},
		classify,
		options,
	);
}

interface PublisherModelList {
	publisherModels?: { name?: string; versionId?: string }[];
}

/** `publishers/google/models/gemini-3.5-flash` 같은 이름에서 모델 id 만 꺼낸다. */
const modelIdOf = (name: string): string => name.split("/").pop() ?? "";

export const vertex: AiProvider = {
	name: "vertex",
	label: "Google Vertex AI",
	consoleUrl: "https://console.cloud.google.com/iam-admin/serviceaccounts",

	assertKeyFormat(apiKey) {
		// 형식 검증과 필수 필드 확인을 함께 한다. 무엇이 빠졌는지 알려줘야 고칠 수 있다.
		parseServiceAccount(apiKey);
	},

	keyLabel(apiKey) {
		// 서비스 계정에는 "끝 4자리" 라는 개념이 없다. 부모가 알아볼 수 있는 건 프로젝트 이름이다.
		return parseServiceAccount(apiKey).project_id;
	},

	async listModels(apiKey) {
		const account = parseServiceAccount(apiKey);

		const body = await call<PublisherModelList>(
			account,
			`${host(LOCATION)}/v1beta1/publishers/google/models?pageSize=200`,
			{ method: "GET" },
			{ timeoutMs: 20_000 },
		);

		const ids = (body.publisherModels ?? [])
			.map((m) => modelIdOf(m.name ?? ""))
			.filter(isUsableGeminiModel);

		// 같은 모델이 버전별로 여러 번 나올 수 있다.
		return sortGeminiModels([...new Set(ids)]);
	},

	async probe(apiKey, model) {
		try {
			const account = parseServiceAccount(apiKey);
			await call(
				account,
				`${host(LOCATION)}/v1/projects/${account.project_id}/locations/${LOCATION}/publishers/google/models/${encodeURIComponent(model)}:generateContent`,
				{
					method: "POST",
					body: JSON.stringify({
						contents: [{ role: "user", parts: [{ text: "ping" }] }],
						generationConfig: { maxOutputTokens: 16 },
					}),
				},
				{ timeoutMs: 25_000, maxAttempts: 1 },
			);
			return null;
		} catch (err) {
			return err instanceof Error ? err.message : "AI 호출을 확인하지 못했습니다.";
		}
	},

	async structured<T>(apiKey: string, request: StructuredRequest, options?: CallOptions): Promise<T> {
		const account = parseServiceAccount(apiKey);

		const body = await call<GenerateContentResponse>(
			account,
			`${host(LOCATION)}/v1/projects/${account.project_id}/locations/${LOCATION}/publishers/google/models/${encodeURIComponent(request.model)}:generateContent`,
			{ method: "POST", body: JSON.stringify(buildGenerateContentBody(request)) },
			options,
		);

		return parseGenerateContentResponse<T>("vertex", body);
	},
};
