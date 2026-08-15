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
 * 두 글이 같은 문자 체계를 쓰는가.
 *
 * 문제 언어를 영어로 두면 문항은 영어인데 Brief 는 한국어다(§17). 이때 글자를 맞대 보는
 * 것은 의미가 없다 — 아무리 충실한 문항도 0 점이 나온다. 근거(evidence)는 원문 그대로
 * 인용하도록 시켰으므로 그것만으로 판정한다.
 */
const hasHangul = (text: string): boolean => /[가-힣]/.test(text);

const sharesScript = (a: string, b: string): boolean => hasHangul(a) === hasHangul(b);

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

	const evidenceRatio = groundedRatio(question.evidence ?? "", brief);

	const answer = question.choices?.[question.correctChoice - 1] ?? "";
	const asked = `${question.questionText} ${answer}`;
	// 문항과 Brief 의 문자 체계가 다르면(영어 출제 + 한국어 정보) 글자 대조가 성립하지 않는다.
	const comparable = sharesScript(asked, brief);
	const questionRatio = comparable ? groundedRatio(asked, brief) : 1;

	if (evidenceRatio < MIN_EVIDENCE_GROUNDING) {
		return {
			ok: false,
			reason:
				"근거가 제공된 책 정보에 없는 내용입니다. 주어진 줄거리·등장인물·사건에 적힌 문장을" +
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

	return { ok: true, reason: null, evidenceRatio, questionRatio };
}
