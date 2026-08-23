/**
 * 근거 검사 — 문항이 **제공된 책 정보 안에서** 나왔는지 확인한다(§9·§10).
 *
 * 프롬프트로 "지어내지 마세요" 라고 부탁하는 것만으로는 부족하다. 지어내는 모델은 근거도
 * 함께 지어낸다. 실제로 검수에서 없는 장면을 다룬 문항이 나왔다.
 *
 * AI 검증 단계도 도움이 안 된다 — **같은 모델이 같은 책을 검수한다.** 모델이 그 책을
 * 잘못 기억하고 있으면 출제도 검수도 같은 방향으로 틀린다.
 *
 * 그래서 서버가 기계적으로 본다. 모델의 정직함에 기대지 않고 **Brief 의 글자와 대조한다.**
 */

/**
 * 한국어는 조사가 붙어 형태가 달라진다 — "잎싹" 이 Brief 에 있어도 문항에는 "잎싹이가" 로
 * 나온다. 토큰을 그대로 비교하면 멀쩡한 근거가 전부 탈락한다.
 *
 * 그래서 **어간이 Brief 안에 들어 있는지**를 본다. 조사는 뒤에 붙으므로 앞부분만 맞으면
 * 같은 말로 친다.
 */
const STEM_LENGTH = 2;

/** 비교용 정규화. 공백·문장부호를 털어 한 줄로 만든다. */
const flatten = (text: string): string =>
	text.toLowerCase().replace(/[\s.,!?"'“”‘’()［］\[\]<>·…~\-—:;/]/g, "");

/**
 * 내용어만 남긴다.
 *
 * 조사·어미만으로 이뤄진 짧은 토막과 숫자는 어느 글에나 있어 근거가 되지 못한다.
 * 이런 것들이 섞이면 지어낸 문항도 점수가 올라간다.
 */
const STOPWORDS = new Set([
	"그리고", "하지만", "그래서", "때문에", "위해", "통해", "대해", "라고", "이라고",
	"에서", "에게", "으로", "하는", "하고", "있는", "있다", "했다", "한다", "된다",
	"모두", "가장", "매우", "다시", "함께", "서로", "이것", "그것", "저것",
]);

function contentTokens(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[\s.,!?"'“”‘’()［］\[\]<>·…~\-—:;/]+/)
		.map((token) => token.trim())
		.filter((token) => token.length >= STEM_LENGTH)
		.filter((token) => !STOPWORDS.has(token))
		// 숫자만 있는 토막은 어디에나 있다.
		.filter((token) => !/^\d+$/.test(token));
}

/**
 * 이 토큰이 Brief 안에 있는가.
 *
 * 앞 두 글자(어간)가 Brief 에 들어 있으면 같은 말로 본다. 조사가 뭐가 붙든 통과하고,
 * 전혀 다른 말은 걸린다.
 */
const appearsIn = (token: string, flatBrief: string): boolean =>
	flatBrief.includes(token.slice(0, Math.max(STEM_LENGTH, Math.ceil(token.length * 0.7))));

/**
 * 이 글의 내용이 Brief 에 얼마나 담겨 있는지. 0~1.
 *
 * 1 에 가까울수록 Brief 에 적힌 말로만 이뤄졌다는 뜻이다.
 */
export function groundedRatio(text: string, brief: string): number {
	const tokens = contentTokens(text);
	if (tokens.length === 0) return 0;

	const flatBrief = flatten(brief);
	let found = 0;
	for (const token of tokens) if (appearsIn(token, flatBrief)) found++;

	return found / tokens.length;
}

/**
 * 근거가 Brief 에서 나왔다고 인정하는 하한.
 *
 * 실제 생성 결과로 재어 정했다. 제대로 된 문항의 근거는 0.8 을 넘고, 모델이 기억으로
 * 지어낸 문항은 0.5 아래로 떨어진다. 그 사이를 가른다.
 *
 * 낮추면 지어낸 문항이 새고, 높이면 표현을 바꿔 쓴 멀쩡한 근거까지 떨어진다.
 */
export const MIN_EVIDENCE_GROUNDING = 0.65;

/**
 * 문제와 정답이 Brief 에 없는 고유명사를 끌어들였는지.
 *
 * **오답 선택지는 보지 않는다.** 오답은 그럴듯하게 지어내는 것이 제 역할이라 Brief 에 없는
 * 이름이 나오는 게 정상이다. 문제 본문과 정답에만 적용한다.
 */
export const MIN_QUESTION_GROUNDING = 0.5;

/**
 * **정답**이 줄거리 절 안에서 나왔다고 인정하는 하한.
 *
 * 문제 본문과 따로 재는 이유: 문제 문장에는 배경 낱말(시리즈명·수상 이력)이 섞여도 되지만,
 * 정답은 아이가 책을 읽어야만 아는 것이어야 한다. 정답이 홍보 문구의 낱말로만 이뤄졌다면
 * 그 문제는 소개문만 읽어도 풀린다(§7).
 *
 * 실측 표본으로 정했다(`test/grounding.test.ts` 의 두 무리, `[줄거리]·[등장인물]·[주요 사건]`
 * 절과 대조).
 *
 *   제대로 조사한 정보로 만든 문항 4개   1.00 · 1.00 · 1.00 · 1.00
 *   기억으로 지어낸 문항 2개            0.50 · 0.20
 *
 * 두 무리 사이가 넓어 0.6 은 어느 쪽에도 걸리지 않는다.
 */
export const MIN_ANSWER_GROUNDING = 0.6;

/**
 * 근거로 인정할 최소 길이.
 *
 * 비율 검사에는 길이 하한이 없어서, 낱말 하나만 적어 보내면 비율이 1.0 이 된다("잎싹"). 그건
 * 인용이 아니라 우연이다. 실측 표본의 근거는 51~75자였으므로 20자는 멀쩡한 근거를 걸지 않는다.
 *
 * 영어 근거에는 더 길게 요구한다 — 알파벳은 글자당 정보가 적다. `hasVerbatimQuote` 의 창 길이와
 * 같은 이유이고 같은 비율(14:28)을 쓴다.
 */
const MIN_EVIDENCE_LENGTH_KO = 20;
const MIN_EVIDENCE_LENGTH_EN = 40;

/**
 * 두 글이 같은 문자 체계를 쓰는가.
 *
 * 문제 언어를 영어로 두면 문항은 영어인데 Brief 는 한국어다(§17). 이때 글자를 맞대 보는
 * 것은 의미가 없다 — 아무리 충실한 문항도 0 점이 나온다. 근거(evidence)는 원문 그대로
 * 인용하도록 시켰으므로 그것만으로 판정한다.
 */
const hasHangul = (text: string): boolean => /[가-힣]/.test(text);

const sharesScript = (a: string, b: string): boolean => hasHangul(a) === hasHangul(b);

/**
 * 이 글이 **주로** 어느 말로 쓰였는가.
 *
 * "한글이 한 자라도 있는가"(`hasHangul`)로는 Brief 의 언어를 알 수 없다. Brief 의 절 머리와
 * 이름표는 영문책이어도 늘 한국어다 — `[줄거리]`·`지은이:`·`출판사:`. 그래서 영문책의 Brief 도
 * 한글을 담고 있고, 한 자만 보는 판정은 **모든 책을 한국어로 본다.**
 *
 * 그래서 글자 수를 센다. 줄거리와 웹 자료가 본문의 대부분이므로 그쪽 말이 이긴다.
 * 한글은 한 글자가 곧 형태소라 알파벳보다 밀도가 높은데, 이 판정은 압도적인 차이만 가리므로
 * 그 차이를 보정할 필요가 없다.
 *
 * 짧은 글(근거 한 문장)에도 그대로 쓸 수 있다.
 */
export const dominantScript = (text: string): "ko" | "en" =>
	(text.match(/[가-힣]/g)?.length ?? 0) >= (text.match(/[A-Za-z]/g)?.length ?? 0) ? "ko" : "en";

/**
 * 근거를 **번역해 적었는가.**
 *
 * 책 정보와 근거가 서로 다른 말로 쓰였으면 모델이 원문을 옮긴 것이 아니라 자기 말로 옮긴
 * 것이다. 글자 대조가 아예 성립하지 않으므로 비율은 0 에 가깝게 나오고, 그 사실을 사유에
 * 적어 주어야 다음 라운드가 고칠 수 있다.
 *
 * 탈락으로 이미 갈린 문항의 **사유를 고르는 데만** 쓴다. 이 판정으로 통과·탈락을 가르지 않는다.
 * 그래서 여기만 `dominantScript` 를 쓰고, 통과·탈락을 가르는 `comparable` 은 예전 판정을
 * 그대로 둔다 — 판정 기준을 함께 바꾸면 지금 잘 되는 책의 결과가 달라진다.
 */
const translatedEvidence = (evidence: string, base: string): boolean =>
	evidence.trim() !== "" && dominantScript(evidence) !== dominantScript(base);

/* ── 무엇과 대조하는가 (§Phase 3) ─────────────────────── */

/**
 * 웹에서 읽은 페이지가 실리는 Brief 절의 이름. `book.ts` 가 이 이름으로 쓰고 여기서 찾는다.
 */
export const WEB_SECTION = "[웹 자료]";

/**
 * 출제 근거로 인정하는 절들.
 *
 * `[소개]`·`[출판사 소개]` 는 **빠져 있다.** 그건 홍보 문구라 그것만으로 답할 수 있는 문제는
 * 책을 읽지 않아도 풀린다(§7). `[출처]` 는 URL 목록이라 근거가 아니다.
 */
const EVIDENCE_SECTIONS = [WEB_SECTION, "[줄거리]", "[등장인물]", "[주요 사건"];

/**
 * 절 머리로 볼 줄. **괄호만 있는 줄**이어야 한다.
 *
 * 처음에는 `[` 로 시작하기만 하면 절 머리로 봤다가 `[웹 자료]` 의 본문이 통째로 사라졌다 —
 * 그 안의 자료 이름표가 `[자료 1] 움푹산의 비밀 서평` 이라 새 절로 잘렸기 때문이다.
 * `buildBrief` 는 절 머리를 항상 한 줄에 단독으로 쓰므로 이 규칙으로 정확히 갈린다.
 */
const HEADER = /^\[[^\]]+\]$/;

/** 절 머리를 경계로 Brief 를 자른다. */
function sectionsOf(brief: string): { header: string; body: string }[] {
	const out: { header: string; body: string }[] = [];
	let current: { header: string; body: string } | null = null;

	for (const line of brief.split("\n")) {
		if (HEADER.test(line.trim())) {
			current = { header: line.trim(), body: "" };
			out.push(current);
			continue;
		}
		if (current) current.body += `${line}\n`;
	}
	return out;
}

/**
 * 근거를 대조할 범위를 정한다.
 *
 * **웹 자료가 있을 때만 좁힌다.** 없으면 Brief 전체를 그대로 쓴다 — 지금 잘 되는 책이
 * 갑자기 전부 탈락하면 안 된다.
 *
 * 좁혀야 하는 이유는 PR #30 에서 측정한 것이다. 지금은 모델이 기억으로 쓴 `[줄거리]` 도
 * 대조 대상이라 **모델이 자기가 지어낸 줄거리를 근거로 자기 문항을 정당화**할 수 있다.
 * 웹 자료가 있으면 그 자료가 기준점이 되고, 홍보 문구(`[소개]`)는 근거에서 빠진다.
 *
 * `[줄거리]` 를 남기는 이유: 웹 자료를 발췌해 만든 요약이고, 부모가 직접 적은 줄거리도
 * 거기 들어간다(PR #30) — 가장 믿을 만한 출처를 근거에서 빼면 안 된다.
 */
/**
 * 출제 근거로 인정되는 절만 남긴다. **웹 자료가 없어도 좁힌다.**
 *
 * `evidenceBase` 와 다른 점이 그것이다. 그쪽은 웹 자료가 있을 때만 좁히는데, 그 조심스러움은
 * "지금 잘 되는 책이 갑자기 전부 탈락하면 안 된다" 는 이유였다(PR #30). 근거(evidence) 검사에는
 * 그 조심스러움이 여전히 맞다 — 모델이 인용할 만한 문장은 소개에도 있다.
 *
 * 그러나 **정답**은 다르다. 정답이 홍보 문구에만 있는 낱말로 이뤄졌다면 그 문제는 책을 읽지
 * 않아도 풀린다(§7). 정답은 늘 줄거리·인물·사건 안에서 나와야 한다.
 *
 * 남길 절의 본문이 전부 비어 있으면 Brief 전체로 되돌린다 — 대조할 것이 없는데 전부 떨어뜨리면
 * 문제를 하나도 만들 수 없다.
 */
export function plotBase(brief: string): string {
	const kept = sectionsOf(brief).filter((section) =>
		EVIDENCE_SECTIONS.some((name) => section.header.startsWith(name)),
	);

	if (kept.length === 0 || kept.every((section) => section.body.trim() === "")) return brief;
	return kept.map((section) => `${section.header}\n${section.body}`).join("\n");
}

export function evidenceBase(brief: string): string {
	if (!brief.includes(WEB_SECTION)) return brief;

	const kept = sectionsOf(brief).filter((section) =>
		EVIDENCE_SECTIONS.some((name) => section.header.startsWith(name)),
	);

	/*
	 * **머리글이 아니라 본문이 있는지**를 본다.
	 *
	 * `[웹 자료]` 절만 있고 그 아래가 비어 있는 Brief 가 나올 수 있다. 머리글 글자로 빈 것을
	 * 판정하면 그 경우를 놓치고, 근거 범위가 "[웹 자료]" 여섯 글자가 되어 **모든 문항이
	 * 탈락한다.**
	 */
	if (kept.every((section) => section.body.trim() === "")) return brief;

	return kept.map((section) => `${section.header}\n${section.body}`).join("\n");
}

/* ── 통째로 옮겨 적었는가 ─────────────────────────────── */

/**
 * 원문에서 **그대로 옮겨 온 것**으로 볼 만한 최소 길이.
 *
 * 어간 비율(`groundedRatio`)은 근거를 낱말 단위로 흩어 본다. 그래서 모델이 원문 한 문장을
 * 정확히 옮기고 뒤에 자기 말로 한 마디를 덧붙이면, 옮긴 부분이 아무리 정확해도 비율이
 * 기준 아래로 내려가 문항이 떨어진다. 실제로 겪은 탈락의 상당수가 이런 경우다.
 *
 * 반대로 **이만큼 긴 글자열이 책 정보에 그대로 있다는 것은 지어낸 근거일 수 없다.** 그래서
 * 이 검사는 비율 검사를 느슨하게 하는 것이 아니라, 다른 각도에서 더 확실한 증거를 보는 것이다.
 *
 * 한국어는 글자 하나가 곧 형태소라 짧아도 충분하고, 영어는 낱말이 길어 그만큼 늘린다.
 */
const VERBATIM_KO = 14;
const VERBATIM_EN = 28;

/** 이어진 글자열을 비교하려면 공백만 접는다. 문장부호까지 털면 자리가 어긋난다. */
const collapse = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * 근거에서 훑어볼 앞머리 길이.
 *
 * 근거는 한 문장이면 충분하고 실제로도 그렇게 온다. 그런데 이 값은 **모델이 정한다** — 스키마에
 * 길이 상한이 없어 수천 자를 보내는 것을 막을 방법이 없다. 창을 미는 횟수가 근거 길이에
 * 비례하므로 앞머리만 본다. 인용은 어차피 앞에 있다.
 */
const MAX_SCAN = 1_000;

/**
 * 근거 안에 책 정보의 글을 **이어진 채로 옮긴 대목**이 있는가.
 *
 * 창을 밀며 포함 여부만 본다. 훑는 길이에 상한이 있고 네이티브 `includes` 를 쓰므로,
 * AI 호출 하나에 비하면 잴 수 없는 시간이다.
 */
export function hasVerbatimQuote(evidence: string, base: string): boolean {
	const needleText = collapse(evidence).slice(0, MAX_SCAN);
	const haystack = collapse(base);
	const window = hasHangul(evidence) ? VERBATIM_KO : VERBATIM_EN;

	if (needleText.length < window || haystack.length < window) return false;

	for (let i = 0; i + window <= needleText.length; i++) {
		if (haystack.includes(needleText.slice(i, i + window))) return true;
	}
	return false;
}

/**
 * Brief 에서 절 하나의 본문만 꺼낸다. 없으면 빈 문자열.
 *
 * 조사를 다시 돌릴 때 **지금까지 정리한 줄거리**를 모델에게 되돌려 주려고 쓴다. 절을 자르는
 * 규칙이 이미 여기 있으므로 같은 것을 두 번 구현하지 않는다.
 */
export function sectionBody(brief: string, header: string): string {
	const found = sectionsOf(brief).find((section) => section.header === header);
	return found ? found.body.trim() : "";
}

export interface GroundingResult {
	ok: boolean;
	/** 왜 떨어졌는지. 재생성 프롬프트에 그대로 실어 같은 실수를 반복하지 않게 한다. */
	reason: string | null;
	evidenceRatio: number;
	questionRatio: number;
}

/**
 * 한 문항이 Brief 안에서 나왔는지 판정한다.
 *
 * `brief` 가 비어 있으면 검사하지 않는다 — 대조할 것이 없는데 전부 떨어뜨리면
 * 문제를 하나도 만들 수 없다.
 */
export function checkGrounding(
	question: { questionText: string; choices: string[]; correctChoice: number; evidence: string },
	brief: string,
): GroundingResult {
	const idle = { ok: true, reason: null, evidenceRatio: 1, questionRatio: 1 };
	if (brief.trim() === "") return idle;

	/*
	 * 근거는 **출제 근거로 인정되는 절**과만 대조한다(웹 자료가 있을 때). 홍보 문구를 인용한
	 * 문항이 근거 검사를 통과하면 §7 이 무력해진다.
	 */
	const base = evidenceBase(brief);
	const evidence = question.evidence ?? "";
	const evidenceRatio = groundedRatio(evidence, base);

	/*
	 * 근거가 **인용이라고 볼 만한 길이**인지 먼저 본다.
	 *
	 * 비율 검사에는 길이 하한이 없어서 낱말 하나만 적어 보내면 비율이 1.0 이 된다. 그건 인용이
	 * 아니라 우연이고, 그런 문항은 무엇을 근거로 삼았는지 부모가 확인할 수 없다.
	 */
	const trimmed = evidence.trim();
	const floor = hasHangul(trimmed) ? MIN_EVIDENCE_LENGTH_KO : MIN_EVIDENCE_LENGTH_EN;
	if (trimmed !== "" && trimmed.length < floor) {
		return {
			ok: false,
			reason:
				"근거가 너무 짧습니다. 어느 대목에서 나왔는지 알 수 있도록 제공된 책 정보의" +
				" 문장을 통째로 옮겨 적으세요.",
			evidenceRatio,
			questionRatio: 1,
		};
	}

	const answer = question.choices?.[question.correctChoice - 1] ?? "";
	const asked = `${question.questionText} ${answer}`;
	// 문항과 Brief 의 문자 체계가 다르면(영어 출제 + 한국어 정보) 글자 대조가 성립하지 않는다.
	const comparable = sharesScript(asked, brief);
	/*
	 * 문제 본문은 **Brief 전체**와 대조한다. 소개에만 나오는 배경 낱말(시리즈명·수상 이력)을
	 * 문제 문장에 쓰는 것 자체는 잘못이 아니다 — 금지되는 것은 그것을 **근거로 삼는** 것이다.
	 */
	const questionRatio = comparable ? groundedRatio(asked, brief) : 1;

	/*
	 * 비율이 낮아도 **이어진 대목을 그대로 옮겼으면** 인정한다. 지어낸 근거는 이 검사를
	 * 통과할 수 없고, 원문을 옮긴 뒤 한마디 덧붙인 근거는 여기서 살아난다.
	 */
	if (evidenceRatio < MIN_EVIDENCE_GROUNDING && !hasVerbatimQuote(evidence, base)) {
		return {
			ok: false,
			/*
			 * **무엇이 틀렸는지를 정확히 말한다.** 이 사유가 다음 라운드 프롬프트에 그대로
			 * 실리기 때문이다(`ai/generate.ts` 의 "탈락한 문제" 목록).
			 *
			 * 근거를 번역해 적은 경우가 특히 그렇다. 문제 언어를 영어로 두면 모델은 지시를
			 * 어기고 근거까지 영어로 옮기는 일이 잦고, 그러면 한 배치가 통째로 떨어진다.
			 * 예전 사유("책 정보에 없는 내용입니다")로는 모델이 무엇을 고쳐야 할지 알 수
			 * 없어 세 라운드를 같은 실수로 태웠다.
			 *
			 * 번역 사유에는 `제공된 책 정보` 라는 말을 **쓰지 않는다.** 그 말이 부모에게
			 * 보여줄 안내를 고르는 표시이기 때문이다(`generation.mostlyUngrounded`) —
			 * 번역은 책 정보가 모자란 것이 아니라 모델이 지시를 어긴 것이므로, 부모에게
			 * "줄거리를 보강해 주세요" 라고 할 일이 아니다.
			 */
			reason: translatedEvidence(evidence, base)
				? "근거를 다른 언어로 바꿔 적었습니다. evidence 는 책 정보에 적힌 문장을" +
					" **그 언어 그대로** 옮겨야 합니다. 번역하지 마세요."
				: "근거가 제공된 책 정보에 없는 내용입니다. 주어진 줄거리·등장인물·사건에 적힌 문장을" +
					" 원문 그대로 인용하세요.",
			evidenceRatio,
			questionRatio,
		};
	}

	if (comparable && questionRatio < MIN_QUESTION_GROUNDING) {
		return {
			ok: false,
			reason: "문제와 정답이 제공된 책 정보에 없는 인물·장면을 다룹니다.",
			evidenceRatio,
			questionRatio,
		};
	}

	/*
	 * **정답은 줄거리 안에서 나와야 한다.**
	 *
	 * 위의 문제 본문 검사는 Brief 전체와 대조한다 — 문제 문장에 배경 낱말이 섞이는 것은 잘못이
	 * 아니기 때문이다. 정답은 다르다. 아이가 책을 읽어야만 아는 것이어야 하고, 홍보 문구
	 * (`[소개]`·`[출판사 소개]`)의 낱말로만 이뤄진 정답은 소개문만 읽어도 맞힐 수 있다(§7).
	 *
	 * 그래서 정답만 따로, **줄거리·인물·사건 절과만** 대조한다.
	 */
	const answerComparable = sharesScript(answer, brief);
	const answerRatio = answerComparable ? groundedRatio(answer, plotBase(brief)) : 1;

	if (answerComparable && answerRatio < MIN_ANSWER_GROUNDING) {
		return {
			ok: false,
			reason:
				"정답이 줄거리·등장인물·주요 사건에 없는 내용입니다. 소개문이 아니라" +
				" 줄거리에 적힌 사건으로 문제를 만드세요.",
			evidenceRatio,
			questionRatio,
		};
	}

	return { ok: true, reason: null, evidenceRatio, questionRatio };
}
