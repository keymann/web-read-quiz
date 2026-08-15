import { toDataUrl } from "../utils/image";
import { ApiError } from "../utils/response";
import { logAiError, parseStructured, requestJson } from "./http";
import { assertOpenAiKeyShape } from "./keyshape";
import type { AiProvider, CallOptions, Classify, StructuredRequest } from "./types";

/** OpenAI 구현 — Responses API + Structured Output. */

const BASE_URL = "https://api.openai.com/v1";

/** 문제 생성·검증에 쓸 수 없는 계열. `/v1/models` 는 id 만 주므로 이름으로 거를 수밖에 없다. */
const EXCLUDED_SUBSTRINGS = [
	"embedding",
	"moderation",
	"tts",
	"transcribe",
	"whisper",
	"audio",
	"realtime",
	"image",
	"dall-e",
	"codex",
	"search",
	"computer-use",
	// 텍스트 완성 전용이라 채팅·구조화 출력을 쓸 수 없다.
	"instruct",
	// 가리키는 실제 모델이 예고 없이 바뀌는 별칭. 재현 가능한 출제를 위해 제외한다.
	"chat-latest",
];

/** 구조화 출력과 긴 컨텍스트가 필요한 작업이라 이 세대는 후보에서 뺀다. */
const EXCLUDED_PREFIXES = ["gpt-3.5"];

/** `gpt-5.5-2026-04-23` 같은 날짜 스냅샷. 기본 별칭과 중복이라 목록에서 숨긴다. */
const SNAPSHOT_RE = /-\d{4}-\d{2}-\d{2}$/;

/** 앞에 있을수록 우선. 더 구체적인 접두사를 먼저 둬야 `gpt-5.6` 이 `gpt-5` 에 먹히지 않는다. */
const FAMILY_PREFERENCE = [
	"gpt-5.6",
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.3",
	"gpt-5.2",
	"gpt-5.1",
	"gpt-5",
	"gpt-4.1",
	"gpt-4o",
	"o4",
	"o3",
	"o1",
];

const classify: Classify = (status, body) => {
	const error = (body as { error?: { message?: string; code?: string; type?: string } } | null)?.error;
	const message = error?.message ?? "";
	const code = error?.code ?? error?.type ?? "";

	logAiError("openai", status, code, message);

	if (status === 401) {
		return {
			error: new ApiError("invalid", "OpenAI API Key 가 올바르지 않습니다. 다시 확인해 주세요.", 400),
			retryable: false,
		};
	}

	if (status === 429) {
		// 429 는 두 가지가 섞여 있다. 크레딧 소진은 기다려도 풀리지 않으므로 재시도하지 않고
		// 결제 설정을 안내한다. 잠깐의 호출량 초과와 구분해야 부모가 대응할 수 있다.
		if (code === "insufficient_quota" || message.includes("quota")) {
			return {
				error: new ApiError(
					"invalid",
					"OpenAI 크레딧이 부족합니다. platform.openai.com 의 Billing 에서 결제 수단과 잔액을 확인해 주세요.",
					400,
				),
				retryable: false,
			};
		}
		return {
			error: new ApiError("ai_failed", "OpenAI 호출량 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요.", 502),
			retryable: true,
		};
	}

	if (status === 403) {
		return {
			error: new ApiError("invalid", "이 API Key 로는 사용할 수 없는 요청입니다.", 400),
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
		retryable: status >= 500,
	};
};

const call = <T>(apiKey: string, path: string, init: RequestInit, options?: CallOptions) =>
	requestJson<T>(
		`${BASE_URL}${path}`,
		{
			...init,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				...init.headers,
			},
		},
		classify,
		options,
	);

interface ModelListResponse {
	data: { id: string }[];
}

interface ResponsesBody {
	status?: string;
	incomplete_details?: { reason?: string };
	output?: { type?: string; content?: { type?: string; text?: string }[] }[];
}

/**
 * `output` 배열에서 첫 번째 `output_text` 를 꺼낸다.
 * 툴을 쓰면 앞쪽에 `web_search_call` 같은 항목이 섞이므로 message 만 골라야 한다.
 */
function extractText(body: ResponsesBody): string | null {
	for (const item of body.output ?? []) {
		if (item.type !== undefined && item.type !== "message") continue;
		for (const part of item.content ?? []) {
			if (part.type === "output_text" && typeof part.text === "string") return part.text;
		}
	}
	return null;
}

function rank(id: string): number {
	const family = FAMILY_PREFERENCE.find((prefix) => id.startsWith(prefix));
	if (family === undefined) return 999;

	const suffix = id.slice(family.length);
	const variant =
		suffix === "" ? 0 : suffix === "-pro" ? 3 : suffix === "-mini" || suffix === "-nano" ? 2 : 1;

	return FAMILY_PREFERENCE.indexOf(family) * 10 + variant;
}

function isUsable(id: string): boolean {
	if (!/^gpt-/.test(id) && !/^o\d/.test(id)) return false;
	if (SNAPSHOT_RE.test(id)) return false;
	if (EXCLUDED_PREFIXES.some((prefix) => id.startsWith(prefix))) return false;
	return !EXCLUDED_SUBSTRINGS.some((word) => id.includes(word));
}

export const openai: AiProvider = {
	name: "openai",
	label: "OpenAI",
	consoleUrl: "https://platform.openai.com/api-keys",

	assertKeyFormat: assertOpenAiKeyShape,

	keyLabel: (apiKey) => `끝 4자리 ${apiKey.slice(-4)}`,

	async listModels(apiKey) {
		const body = await call<ModelListResponse>(apiKey, "/models", { method: "GET" }, {
			timeoutMs: 15_000,
		});

		return body.data
			.map((m) => m.id)
			.filter(isUsable)
			.sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b));
	},

	async probe(apiKey, model) {
		try {
			await call(
				apiKey,
				"/responses",
				{ method: "POST", body: JSON.stringify({ model, input: "ping", max_output_tokens: 16 }) },
				{ timeoutMs: 20_000, maxAttempts: 1 },
			);
			return null;
		} catch (err) {
			return err instanceof Error ? err.message : "AI 호출을 확인하지 못했습니다.";
		}
	},

	async structured<T>(apiKey: string, request: StructuredRequest, options?: CallOptions): Promise<T> {
		const content: unknown[] = [{ type: "input_text", text: request.prompt }];
		if (request.image) {
			content.push({
				type: "input_image",
				image_url: toDataUrl(request.image.bytes, request.image.mime),
			});
		}

		const body = await call<ResponsesBody>(
			apiKey,
			"/responses",
			{
				method: "POST",
				body: JSON.stringify({
					model: request.model,
					input: [{ role: "user", content }],
					...(request.instructions ? { instructions: request.instructions } : {}),
					...(request.webSearch ? { tools: [{ type: "web_search" }] } : {}),
					text: {
						format: {
							type: "json_schema",
							name: request.schemaName,
							strict: true,
							schema: request.schema,
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

		return parseStructured<T>("openai", extractText(body));
	},
};
