import { structured } from "../ai/responses";
import { BOOK_RESEARCH_SCHEMA } from "../ai/schemas";
import type { BibRecord } from "./bibliographic";

/**
 * 파이프라인 2단계 — 웹 검색으로 문제 출제에 쓸 서술 정보를 모은다(§6).
 *
 * OpenAI Responses API 의 내장 `web_search` 툴을 쓴다. 별도 검색 API Key 를 받지 않아도 되고,
 * 검색과 정리가 한 번의 호출로 끝나 비용도 아낀다(§28).
 */

export interface BookResearch {
	found: boolean;
	title: string;
	author: string;
	publisher: string;
	isbn13: string;
	publishedAt: string;
	targetAge: string;
	description: string;
	plotSummary: string;
	characters: { name: string; role: string }[];
	keyEvents: string[];
	sources: { url: string; title: string; content: string }[];
}

/** 출처별 발췌 상한. 원문을 그대로 쌓아 두지 않기 위한 장치다(§6). */
export const MAX_SOURCE_CONTENT = 2_000;

const INSTRUCTIONS = `당신은 어린이 책 정보를 조사하는 사서입니다.
web_search 로 공개된 정보를 찾아 아래 원칙에 따라 정리하세요.

원칙:
- 책의 **본문 원문을 그대로 옮기지 마세요.** 출판사 소개글, 서평, 독후감, 도서관 자료처럼
  공개적으로 제공되는 정보만 요약해서 씁니다.
- plotSummary 는 결말까지 포함해 구체적으로 씁니다. 이후 이 내용으로 독서 확인 문제를 만들기 때문에
  "감동적인 이야기" 같은 뭉뚱그린 표현이 아니라 누가 무엇을 했는지 적으세요.
- characters 와 keyEvents 도 최대한 구체적으로 채웁니다. keyEvents 는 일어난 순서대로 씁니다.
- **확인하지 못한 내용은 지어내지 마세요.** 찾지 못한 항목은 빈 문자열이나 빈 배열로 둡니다.
- 검색으로 이 책을 특정하지 못했다면 found 를 false 로 두고 나머지는 비워 두세요.
- sources 에는 실제로 참고한 페이지의 URL 과 제목, 그리고 그 페이지에서 얻은 내용의 요약을 남깁니다.`;

export async function research(
	apiKey: string,
	model: string,
	hint: { title: string; author: string; publisher: string; isbn: string; bib: BibRecord[] },
): Promise<BookResearch> {
	const known = hint.bib
		.map((r) => `- ${r.source}: ${r.title} / ${r.author} / ${r.publisher} / ${r.publishedAt}`)
		.join("\n");

	// ISBN 이 있으면 그것으로, 없으면 제목·저자·출판사 조합으로 찾게 한다(§5).
	const query = hint.isbn
		? `ISBN ${hint.isbn} 인 책`
		: `"${hint.title}" (지은이: ${hint.author || "미상"}, 출판사: ${hint.publisher || "미상"})`;

	const input = [
		`다음 책을 조사해 주세요: ${query}`,
		known ? `\n서지 데이터베이스에서 확인된 정보:\n${known}` : "",
		"\n이 책은 초등학교 고학년 아이의 독서 확인 문제를 만드는 데 쓰입니다.",
		"줄거리·등장인물·사건 순서를 최대한 구체적으로 정리해 주세요.",
	].join("");

	const result = await structured<BookResearch>(
		apiKey,
		{
			model,
			instructions: INSTRUCTIONS,
			schemaName: "book_research",
			schema: BOOK_RESEARCH_SCHEMA,
			tools: [{ type: "web_search" }],
			input,
		},
		// 웹 검색이 붙으면 응답이 느리다. 재시도는 비싸므로 한 번만 보낸다.
		{ timeoutMs: 180_000, maxAttempts: 1 },
	);

	return {
		...result,
		sources: result.sources
			.filter((s) => s.url.startsWith("http"))
			.map((s) => ({ ...s, content: s.content.slice(0, MAX_SOURCE_CONTENT) })),
	};
}
