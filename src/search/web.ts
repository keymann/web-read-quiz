import { BOOK_RESEARCH_SCHEMA } from "../ai/schemas";
import type { AiProvider } from "../ai/types";
import type { BibRecord } from "./bibliographic";

/**
 * 파이프라인 2단계 — 웹 검색으로 문제 출제에 쓸 서술 정보를 모은다(§6).
 *
 * 제공자 내장 검색 툴을 쓴다(OpenAI `web_search` / Gemini Google 검색 그라운딩).
 * 별도 검색 API Key 를 받지 않아도 되고, 검색과 정리가 한 번의 호출로 끝나 비용도 아낀다(§28).
 */

export interface BookResearch {
	/** 서버가 도출한다. 모델 응답에는 없다. */
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

/**
 * 검색을 쓸 수 있느냐에 따라 지시를 나눈다.
 *
 * 처음에는 검색용 지시 하나만 두고 프롬프트로 "검색을 못 쓴다"만 덧붙였는데,
 * 시스템 지시가 여전히 "웹 검색으로 찾아라 · sources 에 참고한 페이지를 남겨라"를 요구해서
 * 모델이 모순을 만나면 안전한 쪽(found=false)으로 빠져 버렸다. 널리 알려진 책인데도 그랬다.
 * 지시 자체를 상황에 맞게 바꿔야 한다.
 */
const SEARCH_INSTRUCTIONS = `당신은 어린이 책 정보를 조사하는 사서입니다.
웹 검색으로 공개된 정보를 찾아 아래 원칙에 따라 정리하세요.

원칙:
- 책의 **본문 원문을 그대로 옮기지 마세요.** 출판사 소개글, 서평, 독후감, 도서관 자료처럼
  공개적으로 제공되는 정보만 요약해서 씁니다.
- plotSummary 는 결말까지 포함해 구체적으로 씁니다. 이후 이 내용으로 독서 확인 문제를 만들기 때문에
  "감동적인 이야기" 같은 뭉뚱그린 표현이 아니라 누가 무엇을 했는지 적으세요.
- characters 와 keyEvents 도 최대한 구체적으로 채웁니다. keyEvents 는 일어난 순서대로 씁니다.
- **확인하지 못한 내용은 지어내지 마세요.** 찾지 못한 항목은 빈 문자열이나 빈 배열로 둡니다.
- 검색으로 이 책을 특정하지 못했다면 **모든 항목을 비워** 두세요.
- sources 에는 실제로 참고한 페이지의 URL 과 제목, 그리고 그 페이지에서 얻은 내용의 요약을 남깁니다.`;

const RECALL_INSTRUCTIONS = `당신은 어린이 책에 밝은 사서입니다.
지금은 웹 검색을 쓸 수 없습니다. **당신이 이미 알고 있는 지식만으로** 아래 원칙에 따라 정리하세요.

원칙:
- 이 책을 분명히 알고 있다면 아는 만큼 채웁니다.
  널리 알려진 책이라면 주저하지 말고 기억하는 줄거리와 등장인물을 적으세요.
- 이 책을 모르거나 다른 책과 헷갈린다면 **모든 항목을 비워** 두세요.
- 개별 항목이 기억나지 않으면 그 항목만 비워 둡니다. **지어내지 마세요.**
- 책의 **본문 원문을 그대로 옮기지 마세요.** 줄거리는 당신의 말로 요약합니다.
- plotSummary 는 결말까지 포함해 구체적으로 씁니다. 이후 이 내용으로 독서 확인 문제를 만들기 때문에
  "감동적인 이야기" 같은 뭉뚱그린 표현이 아니라 누가 무엇을 했는지 적으세요.
- characters 와 keyEvents 도 최대한 구체적으로 채웁니다. keyEvents 는 일어난 순서대로 씁니다.
- 참고한 웹 페이지가 없으므로 **sources 는 빈 배열로 둡니다.**`;

export async function research(
	provider: AiProvider,
	apiKey: string,
	model: string,
	hint: { title: string; author: string; publisher: string; isbn: string; bib: BibRecord[] },
	/** 웹 검색 툴을 쓸지. 끄면 모델이 이미 아는 지식만으로 답한다(근거가 약해진다). */
	useWebSearch = true,
): Promise<BookResearch> {
	const known = hint.bib
		.map((r) => `- ${r.source}: ${r.title} / ${r.author} / ${r.publisher} / ${r.publishedAt}`)
		.join("\n");

	/*
	 * 제목·저자는 **항상** 넣고, ISBN 은 있으면 보조 식별자로 덧붙인다.
	 *
	 * 처음에는 §5 를 "ISBN 이 있으면 ISBN 으로 찾는다"로 읽어 ISBN 만 보냈는데, 그러면 프롬프트에
	 * 제목이 아예 등장하지 않는다. 검색을 못 쓰는 경우 모델은 ISBN→책 매핑을 알 도리가 없어
	 * 빈 응답만 돌려준다(실측 확인). 검색을 쓰더라도 제목·저자가 함께 있는 편이 훨씬 잘 찾는다.
	 */
	const query = [
		`"${hint.title}"`,
		`(지은이: ${hint.author || "미상"}, 출판사: ${hint.publisher || "미상"}`,
		hint.isbn ? `, ISBN: ${hint.isbn}` : "",
		")",
	].join("");

	const prompt = [
		`다음 책을 조사해 주세요: ${query}`,
		known ? `\n서지 데이터베이스에서 확인된 정보:\n${known}` : "",
		"\n이 책은 초등학교 고학년 아이의 독서 확인 문제를 만드는 데 쓰입니다.",
		"줄거리·등장인물·사건 순서를 최대한 구체적으로 정리해 주세요.",
	].join("");

	const result = await provider.structured<BookResearch>(
		apiKey,
		{
			model,
			instructions: useWebSearch ? SEARCH_INSTRUCTIONS : RECALL_INSTRUCTIONS,
			prompt,
			webSearch: useWebSearch,
			schemaName: "book_research",
			schema: BOOK_RESEARCH_SCHEMA as unknown as Record<string, unknown>,
		},
		// 웹 검색이 붙으면 응답이 느려서 넉넉히 기다린다.
		// 재시도는 실패한 호출(429·503)에만 일어나고 실패한 호출은 과금되지 않으므로,
		// 모델 과부하(503)로 조사 전체가 무산되지 않게 몇 번은 다시 보낸다.
		{ timeoutMs: 180_000, maxAttempts: 3 },
	);

	// 모델이 실제로 내용을 채웠는지로 판정한다. 스스로 신고하게 하지 않는다.
	const found = result.plotSummary?.trim() !== "" || (result.characters?.length ?? 0) > 0;

	return {
		...result,
		found,
		sources: (result.sources ?? [])
			.filter((s) => s.url.startsWith("http"))
			.map((s) => ({ ...s, content: s.content.slice(0, MAX_SOURCE_CONTENT) })),
	};
}
