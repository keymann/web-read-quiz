import { callOpenAi } from "./client";

/**
 * 사용할 모델을 코드에 고정하지 않는다.
 *
 * OpenAI 모델 라인업은 자주 바뀌고, 계정마다 접근 가능한 모델도 다르다. 특정 이름을 상수로 박아 두면
 * 그 모델이 사라지는 날 서비스가 멈춘다. 대신 부모의 키로 `/v1/models` 를 조회해 **실제 쓸 수 있는
 * 목록**을 얻고, 그중에서 선호 순서에 따라 기본값을 고른다. 부모가 설정 화면에서 직접 바꿀 수도 있다.
 *
 * `/v1/models` 는 id 만 주고 능력(구조화 출력·비전·web_search)은 알려주지 않는다.
 * 따라서 쓸 수 없는 모델을 거르는 일은 이름 기준으로 할 수밖에 없다.
 */

/** 문제 생성·검증에 쓸 수 없는 계열. */
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

interface ModelListResponse {
	data: { id: string }[];
}

/** 이 계정에서 문제 생성에 쓸 만한 모델 id 목록. 선호 순서로 정렬해서 돌려준다. */
export async function listUsableModels(apiKey: string): Promise<string[]> {
	const body = await callOpenAi<ModelListResponse>(apiKey, "/models", { method: "GET" }, {
		timeoutMs: 15_000,
	});

	return body.data
		.map((m) => m.id)
		.filter(isUsable)
		.sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b));
}

function isUsable(id: string): boolean {
	if (!/^gpt-/.test(id) && !/^o\d/.test(id)) return false;
	if (SNAPSHOT_RE.test(id)) return false;
	if (EXCLUDED_PREFIXES.some((prefix) => id.startsWith(prefix))) return false;
	return !EXCLUDED_SUBSTRINGS.some((word) => id.includes(word));
}

/**
 * 세대(10의 자리) + 변종(1의 자리). 낮을수록 먼저.
 * 같은 세대 안에서는 기본 별칭을 가장 앞에 두고, `-pro` 는 가장 비싸므로 자동 선택되지 않게 뒤로 민다.
 * 부모가 설정 화면에서 직접 고르는 것은 막지 않는다.
 */
function rank(id: string): number {
	const family = FAMILY_PREFERENCE.find((prefix) => id.startsWith(prefix));
	if (family === undefined) return 999;

	const suffix = id.slice(family.length);
	const variant =
		suffix === "" ? 0 : suffix === "-pro" ? 3 : suffix === "-mini" || suffix === "-nano" ? 2 : 1;

	return FAMILY_PREFERENCE.indexOf(family) * 10 + variant;
}

/** 부모가 고르지 않았을 때 쓸 기본 모델. 목록이 이미 선호 순이므로 맨 앞을 쓴다. */
export const pickDefault = (models: string[]): string | null => models[0] ?? null;

/**
 * API Key 가 실제로 동작하는지 확인한다.
 * `/v1/models` 는 토큰을 쓰지 않는 가장 싼 인증 확인 방법이다.
 * 키가 틀리면 callOpenAi 가 401 을 `invalid` 로 바꿔 던진다.
 */
export const verifyKey = (apiKey: string): Promise<string[]> => listUsableModels(apiKey);
