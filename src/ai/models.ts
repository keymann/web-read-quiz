import { callOpenAi } from "./client";

/**
 * 사용할 모델을 코드에 고정하지 않는다.
 *
 * OpenAI 모델 라인업은 자주 바뀌고, 계정마다 접근 가능한 모델도 다르다. 특정 이름을 상수로 박아 두면
 * 그 모델이 사라지는 날 서비스가 멈춘다. 대신 부모의 키로 `/v1/models` 를 조회해 **실제 쓸 수 있는
 * 목록**을 얻고, 그중에서 선호 순서에 따라 기본값을 고른다. 부모가 설정 화면에서 직접 바꿀 수도 있다.
 */

/** 문제 생성·검증에 쓸 수 없는 계열. 이름으로 걸러낸다. */
const EXCLUDED = [
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
];

/** 앞에 있을수록 우선. 접두사 매칭이라 세부 버전이 붙어도 걸린다. */
const PREFERENCE = ["gpt-5.6", "gpt-5.5", "gpt-5", "gpt-4.1", "gpt-4o"];

interface ModelListResponse {
	data: { id: string }[];
}

/** 이 계정에서 문제 생성에 쓸 만한 모델 id 목록. 선호 순서로 정렬해서 돌려준다. */
export async function listUsableModels(apiKey: string): Promise<string[]> {
	const body = await callOpenAi<ModelListResponse>(apiKey, "/models", { method: "GET" }, {
		timeoutMs: 15_000,
	});

	const usable = body.data
		.map((m) => m.id)
		.filter((id) => id.startsWith("gpt-") || id.startsWith("o"))
		.filter((id) => !EXCLUDED.some((word) => id.includes(word)));

	return usable.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function rank(id: string): number {
	const index = PREFERENCE.findIndex((prefix) => id.startsWith(prefix));
	return index === -1 ? PREFERENCE.length : index;
}

/** 부모가 고르지 않았을 때 쓸 기본 모델. 목록이 이미 선호 순이므로 맨 앞을 쓴다. */
export const pickDefault = (models: string[]): string | null => models[0] ?? null;

/**
 * API Key 가 실제로 동작하는지 확인한다.
 * `/v1/models` 는 토큰을 쓰지 않는 가장 싼 인증 확인 방법이다.
 * 키가 틀리면 callOpenAi 가 401 을 `invalid` 로 바꿔 던진다.
 */
export const verifyKey = (apiKey: string): Promise<string[]> => listUsableModels(apiKey);
