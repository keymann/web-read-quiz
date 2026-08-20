import { COVER_ORIENTATION_SCHEMA } from "./schemas";
import type { AiProvider, StructuredRequest } from "./types";

/**
 * 표지 사진의 방향을 읽는다(§5 등록).
 *
 * 왜 사람 대신 모델이 보아야 하는가. 부모는 책을 손에 들고 찍는다. 폰을 가로로 들거나 책을
 * 눕혀 두고 찍으면 제목이 옆으로 누운 사진이 등록된다. EXIF 방향은 브라우저가 이미 바로잡지만
 * 그건 **폰이 어떻게 들렸는가**일 뿐, 책이 어느 쪽으로 누웠는가는 아니다.
 *
 * 가로세로 비율로 짐작할 수도 없다 — 가로가 긴 사진에 책이 똑바로 서 있는 경우도, 세로가 긴
 * 사진에 책이 누워 있는 경우도 흔하다. 게다가 90° 인지 270° 인지는 글자를 봐야만 안다.
 *
 * 서지 식별(`ai/vision.ts`)에 얹지 않고 따로 둔다. 이미 등록된 책의 사진도 바로잡아야 하는데,
 * 그때 서지 식별을 다시 돌리면 부모가 손으로 고쳐 둔 지은이·출판사가 AI 값으로 덮인다.
 * 스키마가 두 항목뿐이라 호출 자체도 서지 식별보다 훨씬 싸다.
 */

export interface CoverOrientation {
	/** 시계 방향으로 더 돌려야 하는 각도. 0 · 90 · 180 · 270 중 하나. */
	rotation: number;
	/** 0~1. 낮으면 그대로 둔다 — 잘못 돌리면 똑바른 사진을 눕히는 셈이다. */
	confidence: number;
}

const INSTRUCTIONS = `당신은 책 표지 사진이 어느 쪽으로 누워 있는지 판단하는 도구입니다.

규칙:
- 기준은 **책 제목의 글자**입니다. 제목이 왼쪽에서 오른쪽으로, 위아래가 바르게 읽히는 상태가 0 입니다.
- 사진을 시계 방향으로 몇 도 돌리면 그 상태가 되는지 답합니다. 0 · 90 · 180 · 270 중 하나입니다.
- 세로로 쓴 제목이라도 글자 하나하나의 위아래가 바르면 돌릴 필요가 없습니다. 0 으로 답하세요.
- 사진이 조금 기울어진 것(10~20도)은 회전이 아닙니다. 0 으로 답하세요.
- 제목을 찾을 수 없거나 어느 쪽이 위인지 알 수 없으면 0 으로 답하고 confidence 를 낮게 주세요.`;

/**
 * 요청 조립과 호출을 나눠 둔다. 브라우저가 직접 Gemini 를 부르는 경로(§브라우저 릴레이)에서는
 * 서버가 이 요청을 만들어 내려보내기만 한다 — 프롬프트와 스키마는 서버에만 있어야 한다.
 */
export function buildOrientRequest(
	model: string,
	image: { bytes: Uint8Array; mime: string },
): StructuredRequest {
	return {
		model,
		instructions: INSTRUCTIONS,
		prompt: "이 표지 사진을 똑바로 세우려면 시계 방향으로 몇 도 돌려야 하나요?",
		image,
		schemaName: "cover_orientation",
		schema: COVER_ORIENTATION_SCHEMA as unknown as Record<string, unknown>,
	};
}

/** 네 값 중 하나로 좁힌다. 모델이 무엇을 보내와도 회전량은 여기서 정해진다. */
export const ROTATIONS = [0, 90, 180, 270] as const;

/**
 * 방향을 얼마나 확신해야 사진을 돌릴지.
 *
 * 낮게 잡으면 똑바로 서 있던 사진을 눕히게 된다. 그건 지금보다 나쁘다 — 부모가 고칠 방법이
 * 화면에 없기 때문이다. 확신이 없을 때는 아무것도 하지 않는 편이 맞다.
 */
export const MIN_CONFIDENCE = 0.6;

/**
 * 모델 응답을 회전량으로 정리한다. 서버가 부르든 브라우저가 부르든 이 정리는 서버에서 한다.
 *
 * 확신이 낮으면 0 으로 접는다 — "돌릴 필요 없음" 과 "모르겠음" 을 같게 다룬다. 둘 다 사진을
 * 건드리지 않는 것이 옳은 처리다.
 */
export function normalizeOrientation(raw: {
	rotation?: unknown;
	confidence?: unknown;
}): CoverOrientation {
	const confidence = typeof raw.confidence === "number" ? raw.confidence : 0;
	const degrees = Number(raw.rotation);
	const rotation =
		ROTATIONS.includes(degrees as (typeof ROTATIONS)[number]) && confidence >= MIN_CONFIDENCE
			? degrees
			: 0;

	return { rotation, confidence };
}

export async function detectOrientation(
	provider: AiProvider,
	apiKey: string,
	model: string,
	image: { bytes: Uint8Array; mime: string },
): Promise<CoverOrientation> {
	const raw = await provider.structured<{ rotation: unknown; confidence: unknown }>(
		apiKey,
		buildOrientRequest(model, image),
		{ timeoutMs: 60_000 },
	);

	return normalizeOrientation(raw);
}
