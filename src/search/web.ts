import { BOOK_RESEARCH_SCHEMA } from "../ai/schemas";
import type { AiProvider, StructuredRequest } from "../ai/types";
import type { BibRecord } from "./bibliographic";
import { MAX_EXCERPT, type WebSource } from "./tavily";

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
	/**
	 * 이 책이 쓰인 언어(ISO 639-1). 모르면 빈 문자열.
	 *
	 * 영문책일 때만 AR·Lexile 을 찾아 나서므로 그 판정에 쓴다. 등급 자체는 여기서 묻지
	 * 않는다 — 줄거리를 찾는 질의로는 등급이 적힌 페이지가 결과에 들어오지 않아 늘
	 * 빈손이었다. 지금은 `search/reading-level.ts` 가 전용 질의로 따로 찾는다.
	 */
	bookLanguage: string;
	description: string;
	plotSummary: string;
	characters: { name: string; role: string }[];
	keyEvents: string[];
	sources: { url: string; title: string; content: string }[];
}

/** 프롬프트에 실을 웹 자료 수. 6건 × 1,500자 ≈ 9,000자. */
const MAX_WEB_SOURCES = 6;

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

/**
 * 서지 데이터베이스 책소개를 어떻게 대할지. 검색을 쓰든 안 쓰든 같다.
 *
 * 이 블록의 목적은 "책소개로 줄거리를 대신하라"가 **아니다.** 책소개는 홍보 문구라 그것만으로
 * 문제를 만들면 책을 읽지 않아도 풀린다(§7). 목적은 **대조**다 — 모델이 떠올린 이야기가
 * 검증된 책소개와 다르면, 그건 다른 책을 떠올린 것이다.
 *
 * 실측에서 모델은 『움푹산의 비밀』의 줄거리를 자신 있게 지어냈다(거인 크네 이야기를
 * 소년과 한국 표범 이야기로). 대조할 사실이 프롬프트에 없었기 때문이다.
 */
const BIB_RULE = `
서지 데이터베이스 정보에 대하여:
- 아래 "확인된 정보"는 **공개 서지 API 로 제목·지은이를 대조해 검증한 사실**입니다.
  당신의 기억보다 이쪽을 믿으세요.
- 기억하는 줄거리가 책소개와 **어긋나면 다른 책을 떠올린 것입니다.** 그때는 지어내지 말고
  **모든 항목을 비워** 두세요. 등장인물 이름이나 소재가 책소개와 맞지 않는 경우가 그렇습니다.
- 책소개는 **어느 책인지 확인하는 용도**입니다. 책소개를 그대로 옮겨 plotSummary 를 채우지 마세요.
  책소개밖에 아는 것이 없다면 그것은 이 책을 모르는 것이므로 비워 둡니다.`;

/**
 * 웹 자료를 받았을 때의 지시. **기억으로 정리하는 것이 아니라 발췌하는 것이다.**
 *
 * PR #30 에서 측정한 것이 이 지시의 이유다. 모델은 『움푹산의 비밀』의 줄거리를 통째로
 * 지어냈고, 검증된 출판사 책소개를 줘도 세부는 계속 지어냈다. 대조할 사실이 짧았기 때문이다.
 * 이제는 실제 페이지 원문이 프롬프트에 있으므로 **"자료에 적혀 있는 것만" 이 지킬 수 있는
 * 요구**가 된다.
 *
 * 그래도 프롬프트만 믿지는 않는다. 근거 검사가 이 자료를 기준으로 문항을 기계적으로
 * 걸러낸다(§Phase 3, `services/grounding.ts`).
 */
const EXCERPT_INSTRUCTIONS = `당신은 어린이 책 정보를 정리하는 사서입니다.
아래 [웹 자료] 는 이 책을 다룬 실제 웹 페이지에서 가져온 글입니다. **그 안에 적혀 있는 것만**
정리하세요.

원칙:
- **자료에 없는 사건·인물·결말을 당신의 기억으로 채우지 마세요.** 자료가 다루지 않은 항목은
  빈 문자열이나 빈 배열로 둡니다.
- plotSummary 의 각 문장은 자료 어느 대목에서 나왔는지 말할 수 있어야 합니다.
- 자료에 줄거리가 없고 판매 정보·홍보 문구뿐이라면 **plotSummary 를 비워** 두세요.
  그건 이 책의 내용을 모르는 것과 같습니다.
- 자료가 서로 다른 책을 말하고 있다면 제목·지은이가 맞는 자료만 씁니다.
- 책의 **본문 원문을 길게 옮기지 마세요.** 줄거리는 당신의 말로 요약합니다.
- plotSummary 는 결말까지 포함해 구체적으로 씁니다. 이후 이 내용으로 독서 확인 문제를 만들기
  때문에 "감동적인 이야기" 같은 뭉뚱그린 표현이 아니라 누가 무엇을 했는지 적으세요.
- characters 와 keyEvents 도 자료에 있는 만큼 채웁니다. keyEvents 는 일어난 순서대로 씁니다.
- sources 에는 실제로 근거로 쓴 자료의 URL 과 제목, 그 자료에서 얻은 내용의 요약을 남깁니다.`;

export interface ResearchHint {
	title: string;
	author: string;
	publisher: string;
	isbn: string;
	bib: BibRecord[];
	/** Tavily 로 실제로 읽은 페이지. 있으면 지시가 "기억" 에서 "발췌" 로 바뀐다. */
	web?: WebSource[];
}

/** 조사 요청 조립. 브라우저 릴레이 경로도 이걸 그대로 쓴다. */
export function buildResearchRequest(
	model: string,
	hint: ResearchHint,
	useWebSearch = true,
): StructuredRequest {
	/*
	 * 서지 API 가 준 **책소개까지** 넣는다.
	 *
	 * 예전에는 제목·저자·출판사·출간일만 넣었다. 그런데 우리는 그 책소개를 이미 받아서 HTML 을
	 * 벗기고 캐시까지 해 두고 있었다 — 그걸 조사 모델에게만 안 보여 주고 있었던 것이다.
	 * (Brief 에는 PR #27 로 들어갔지만, 정작 `found` 를 판정하는 이 단계가 못 봤다.)
	 *
	 * 실측 『움푹산의 비밀』(크레용하우스): 책소개 없이 물으면 모델이 갈렸다.
	 *   gemini-3.6-flash        모든 항목을 비워 반환 → brief 가 null → 문제를 만들 수 없다
	 *   gemini-3-flash-preview  줄거리 404자·등장인물 4명·사건 8개를 **통째로 지어냈다**
	 *
	 * 두 번째가 더 위험하다. Brief 자체가 날조되면 근거 검사(`grounding`)는 그 날조를
	 * "근거 있음"으로 인정한다 — 틀린 내용이 근거까지 갖춘다.
	 *
	 * 검증된 책소개는 그 두 갈래를 모두 막는다. 모르는 책에는 실마리를 주고,
	 * 지어내려는 모델에게는 대조할 사실을 준다.
	 */
	const known = hint.bib
		.map((r) => {
			const head = `- ${r.source}: ${r.title} / ${r.author} / ${r.publisher} / ${r.publishedAt}`;
			return r.description?.trim() ? `${head}\n  책소개: ${r.description.trim()}` : head;
		})
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

	/*
	 * 웹 자료를 프롬프트에 싣는다. **소스당 상한을 걸고 상위 몇 건만.**
	 *
	 * 원문을 통째로 넣으면 프롬프트가 수만 자가 되어 비용과 지연이 커지고, 모델이 중간을
	 * 흘린다. Tavily 가 관련도 순으로 정렬해 주므로 앞에서 잘라도 좋은 것이 남는다.
	 */
	const web = (hint.web ?? []).slice(0, MAX_WEB_SOURCES);
	const excerpts = web
		.map((source, index) => `[자료 ${index + 1}] ${source.title}\n${source.content.slice(0, MAX_EXCERPT)}`)
		.join("\n\n");

	const prompt = [
		`다음 책을 조사해 주세요: ${query}`,
		known ? `\n서지 데이터베이스에서 확인된 정보:\n${known}` : "",
		excerpts ? `\n[웹 자료]\n${excerpts}` : "",
		"\n이 책은 초등학교 고학년 아이의 독서 확인 문제를 만드는 데 쓰입니다.",
		"줄거리·등장인물·사건 순서를 최대한 구체적으로 정리해 주세요.",
	].join("");

	/*
	 * 지시는 **자료가 있느냐**로 갈린다.
	 *
	 *   웹 자료 있음  → 발췌하라 (기억으로 채우지 마라)
	 *   검색 툴 사용   → 검색해서 찾아라
	 *   그 외         → 아는 것만 적어라
	 *
	 * 자료를 주고도 "당신이 아는 지식으로" 라고 하면 모델이 자료를 배경으로만 보고 기억으로
	 * 답한다. 실제로 출판사 책소개에서 그런 일이 있었다.
	 */
	const base = excerpts
		? EXCERPT_INSTRUCTIONS
		: useWebSearch
			? SEARCH_INSTRUCTIONS
			: RECALL_INSTRUCTIONS;

	return {
		model,
		// 서지 정보가 있을 때만 대조 규칙을 붙인다. 없는 것을 대조하라고 하면 혼란만 준다.
		instructions: base + (known ? BIB_RULE : ""),
		prompt,
		webSearch: useWebSearch,
		schemaName: "book_research",
		schema: BOOK_RESEARCH_SCHEMA as unknown as Record<string, unknown>,
	};
}

/** ISO 639-1 두 글자만 받는다. */
const cleanLanguage = (raw: string): string => {
	const value = (raw ?? "").trim().toLowerCase();
	return /^[a-z]{2}$/.test(value) ? value : "";
};

/**
 * 모델 응답을 다듬는다.
 *
 * 서버가 부르든 브라우저가 부르든 이 정리는 서버에서 한다. `found` 판정과 발췌 길이 제한은
 * 신뢰 경계 안쪽 규칙이라 클라이언트에 맡길 수 없다.
 */
export function normalizeResearch(result: BookResearch): BookResearch {
	// 모델이 실제로 내용을 채웠는지로 판정한다. 스스로 신고하게 하지 않는다.
	const found = result.plotSummary?.trim() !== "" || (result.characters?.length ?? 0) > 0;

	return {
		...result,
		found,
		bookLanguage: cleanLanguage(result.bookLanguage),
		sources: (result.sources ?? [])
			.filter((s) => s.url.startsWith("http"))
			.map((s) => ({ ...s, content: (s.content ?? "").slice(0, MAX_SOURCE_CONTENT) })),
	};
}

export async function research(
	provider: AiProvider,
	apiKey: string,
	model: string,
	hint: ResearchHint,
	/** 웹 검색 툴을 쓸지. 끄면 모델이 이미 아는 지식만으로 답한다(근거가 약해진다). */
	useWebSearch = true,
): Promise<BookResearch> {
	const result = await provider.structured<BookResearch>(
		apiKey,
		buildResearchRequest(model, hint, useWebSearch),
		// 웹 검색이 붙으면 응답이 느려서 넉넉히 기다린다.
		// 재시도는 실패한 호출(429·503)에만 일어나고 실패한 호출은 과금되지 않으므로,
		// 모델 과부하(503)로 조사 전체가 무산되지 않게 몇 번은 다시 보낸다.
		{ timeoutMs: 180_000, maxAttempts: 3 },
	);

	return normalizeResearch(result);
}
