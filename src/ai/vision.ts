import type { AiProvider } from "./types";
import { BOOK_IDENTITY_SCHEMA } from "./schemas";

/** 파이프라인 1단계 — 책 표지 사진에서 서지정보를 읽는다(§5). */

export interface BookIdentity {
	title: string;
	author: string;
	publisher: string;
	isbn: string;
	series: string;
	confidence: number;
}

const INSTRUCTIONS = `당신은 책 표지 사진에서 서지정보를 읽어내는 도구입니다.

규칙:
- 사진에 실제로 보이는 글자만 옮겨 적습니다.
- 읽을 수 없거나 사진에 없는 항목은 빈 문자열로 둡니다. 절대 추측해서 지어내지 마세요.
- 지은이와 옮긴이·그림 작가가 함께 적혀 있으면 지은이만 author 에 넣습니다.
- 뒤표지 바코드 아래 숫자가 보이면 ISBN 으로 읽되, 하이픈은 빼고 숫자만 넣습니다.
- confidence 는 글자를 얼마나 또렷하게 읽었는지를 0~1 로 나타냅니다.
  흐릿하거나 일부만 보이면 낮게 주세요.`;

export async function identifyBook(
	provider: AiProvider,
	apiKey: string,
	model: string,
	image: { bytes: Uint8Array; mime: string },
): Promise<BookIdentity> {
	return provider.structured<BookIdentity>(
		apiKey,
		{
			model,
			instructions: INSTRUCTIONS,
			prompt: "이 책 표지에서 서지정보를 읽어 주세요.",
			image,
			schemaName: "book_identity",
			schema: BOOK_IDENTITY_SCHEMA as unknown as Record<string, unknown>,
		},
		{ timeoutMs: 90_000 },
	);
}
