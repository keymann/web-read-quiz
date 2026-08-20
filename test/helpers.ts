import { SELF } from "cloudflare:test";

export const ORIGIN = "http://example.com";

/**
 * 쿠키를 들고 다니는 아주 작은 클라이언트.
 * SELF.fetch 는 쿠키를 자동으로 관리하지 않으므로 Set-Cookie 를 직접 이어 붙인다.
 */
export class Client {
	private cookie: string | null = null;

	constructor(private readonly ip = "10.0.0.1") {}

	async request(
		path: string,
		options: { method?: string; body?: unknown; origin?: string | null } = {},
	): Promise<{ status: number; body: any }> {
		const { method = "GET", body, origin = ORIGIN } = options;

		const headers: Record<string, string> = { "CF-Connecting-IP": this.ip };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		if (origin !== null) headers["Origin"] = origin;
		if (this.cookie) headers["Cookie"] = this.cookie;

		const res = await SELF.fetch(`${ORIGIN}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});

		const setCookie = res.headers.get("Set-Cookie");
		if (setCookie) {
			const pair = setCookie.split(";")[0]!;
			this.cookie = pair.endsWith("=") ? null : pair;
		}

		return { status: res.status, body: await res.json().catch(() => null) };
	}

	get = (path: string) => this.request(path);
	post = (path: string, body?: unknown) => this.request(path, { method: "POST", body });
	patch = (path: string, body?: unknown) => this.request(path, { method: "PATCH", body });
	del = (path: string) => this.request(path, { method: "DELETE" });

	/**
	 * multipart 업로드. Content-Type 을 직접 정하면 경계 문자열이 빠져 파싱에 실패한다.
	 *
	 * 표지를 갈아 끼울 때는 `PUT` 이라 메서드를 받는다.
	 */
	async upload(
		path: string,
		form: FormData,
		method = "POST",
	): Promise<{ status: number; body: any }> {
		const headers: Record<string, string> = { "CF-Connecting-IP": this.ip, Origin: ORIGIN };
		if (this.cookie) headers["Cookie"] = this.cookie;

		const res = await SELF.fetch(`${ORIGIN}${path}`, { method, headers, body: form });
		return { status: res.status, body: await res.json().catch(() => null) };
	}
}

let counter = 0;
export const uniqueId = (prefix: string): string => `${prefix}${Date.now() % 100000}${counter++}`;

/** 부모 계정을 만들고 로그인된 클라이언트를 돌려준다. */
/** 테스트 환경의 초대 코드. vitest.config.ts 의 바인딩과 맞춰 둔다. */
export const INVITE_CODE = "test-invite-code";

export async function signupParent(ip?: string): Promise<{ client: Client; loginId: string }> {
	const client = new Client(ip ?? `10.0.0.${(counter % 200) + 1}`);
	const loginId = uniqueId("parent");
	const res = await client.post("/api/auth/signup", {
		loginId,
		password: "password1234",
		password2: "password1234",
		displayName: "부모",
		// 서버가 늘 요구한다. vitest.config.ts 의 INVITE_CODE 와 같은 값이어야 한다.
		invite: INVITE_CODE,
	});
	if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`);
	return { client, loginId };
}

/** 부모 클라이언트로 아이를 추가하고, 그 아이로 로그인한 클라이언트를 함께 돌려준다. */
export async function addChild(
	parent: Client,
	name = "성현",
): Promise<{ childId: string; loginId: string; password: string; client: Client }> {
	const loginId = uniqueId("child");
	const password = "1234";
	const res = await parent.post("/api/children", { name, grade: 5, loginId, password });
	if (res.status !== 201) throw new Error(`addChild failed: ${JSON.stringify(res.body)}`);

	const client = new Client(`10.0.1.${(counter % 200) + 1}`);
	await client.post("/api/auth/login", { loginId, password });

	return { childId: res.body.data.child.id as string, loginId, password, client };
}

/* ── 문제 생성 픽스처 ─────────────────────────────────── */

/**
 * 문항마다 다른 어휘. 어휘가 겹치면 중복 검사(자카드 0.7)에 걸린다.
 *
 * 처음 픽스처는 번호만 다른 같은 문장이라 전부 탈락했다 — 검사가 제대로 도는 증거이기도 했다.
 */
export const FIXTURE_WORDS = [
	"가람", "나루", "다솜", "라온", "마루", "바다", "사슴", "아람", "자연", "차오름",
	"카나리", "타래", "파랑", "하늘", "거북", "노을", "도담", "라일락", "모래", "바람",
	"새벽", "여울", "자작", "초록", "푸름",
];

/** 모든 픽스처 문항이 공통으로 인용하는 문장. 근거 검사가 이 문장을 Brief 에서 찾는다. */
export const FIXTURE_EVIDENCE = "잎싹이 양계장을 나와 초록머리를 기른다";

/**
 * 픽스처 문항의 본문. Brief 와 문항이 같은 문장을 쓰도록 한 곳에서 만든다.
 *
 * 문항마다 **어절 두 개**가 달라지도록 낱말을 둘 쓴다. 하나만 바꾸면 나머지 골격이 그대로라
 * 중복 검사(자카드 0.7)에 걸린다 — 근거 검사를 통과시키려고 문장을 맞추다 보면 이번에는
 * 서로 너무 닮아 탈락한다. 두 검사를 동시에 만족시키는 최소 형태다.
 */
const pairFor = (index: number): [string, string, string] => [
	FIXTURE_WORDS[index % FIXTURE_WORDS.length]!,
	FIXTURE_WORDS[(index * 7 + 3) % FIXTURE_WORDS.length]!,
	FIXTURE_WORDS[(index * 13 + 11) % FIXTURE_WORDS.length]!,
];

/**
 * 낱말에 번호를 붙여 **모든 어절을 문항마다 유일하게** 만든다.
 *
 * 낱말 목록은 25개라 offset 100 이면 0 번과 같은 낱말이 다시 나온다. 표지(제N장) 하나만
 * 다르면 나머지가 전부 같아 자카드 0.71 — 중복 판정이 난다. 실제로 그렇게 걸렸다.
 *
 * 번호를 붙이면 어떤 offset 에서도 겹치지 않는다. 읽기에 예쁘지는 않지만 픽스처의 일이다.
 */
const numbered = (index: number, [a, b, c]: [string, string, string]) =>
	[`${a}${index}`, `${b}${index}`, `${c}${index}`] as const;

const questionSentence = (index: number, triple: [string, string, string]) =>
	`${numbered(index, triple).join(" ")} 는 어떻게 되었나요?`;

const answerSentence = (index: number, triple: [string, string, string]) => {
	const [a, b, c] = numbered(index, triple);
	return `${a} 가 ${b} ${c} 를 만났다`;
};

/**
 * 픽스처용 줄거리.
 *
 * 근거 검사(`services/grounding.ts`)는 문항이 **제공된 Brief 안에서** 나왔는지 글자로 대조한다.
 * 픽스처 문항도 그 검사를 통과해야 하므로 Brief 가 그 문장들을 담고 있어야 한다.
 *
 * 그래서 문항과 **똑같은 문장**으로 Brief 를 만든다. 실제 책 정보처럼 보이지는 않지만,
 * 이 픽스처의 목적은 "근거를 댈 수 있는 문항" 을 만드는 것이지 그럴듯한 줄거리가 아니다.
 * 실제 근거 검사의 판별력은 `grounding.test.ts` 가 진짜 모델 출력으로 확인한다.
 */
export const FIXTURE_PLOT = [
	`${FIXTURE_EVIDENCE}.`,
	// 테스트가 쓰는 offset(최대 300 + 문항 수)까지 모두 담아 둔다. 담기지 않은 번호로
	// 문항을 만들면 근거를 댈 곳이 없어 전부 탈락한다.
	...Array.from({ length: 400 }, (_, i) => {
		const pair = pairFor(i);
		return `${questionSentence(i, pair)} ${answerSentence(i, pair)}.`;
	}),
].join(" ");

export interface FixtureQuestion {
	questionNumber: number;
	questionText: string;
	choices: string[];
	correctChoice: number;
	questionType: string;
	difficulty: number;
	explanation: string;
	evidence: string;
	readRequired: boolean;
}

const FIXTURE_TYPES = [
	"EVENT", "CHARACTER", "DETAIL", "SEQUENCE", "CAUSE_EFFECT", "ACTION", "EMOTION", "INFERENCE",
];

/**
 * 검사를 통과하는 문항 n개.
 *
 * `offset` 을 달리하면 어휘가 겹치지 않는 다른 묶음이 나온다 — 재생성·재도전 테스트에서
 * "새 문제" 를 만들 때 쓴다.
 */
export function makeQuestions(count: number, offset = 0): FixtureQuestion[] {
	return Array.from({ length: count }, (_, i) => {
		const index = offset + i;
		const pair = pairFor(index);
		const [a, b, c] = numbered(index, pair);
		return {
			questionNumber: i + 1,
			questionText: questionSentence(index, pair),
			choices: [
				answerSentence(index, pair),
				`${a} 가 혼자 있었다`,
				`${b} 가 떠났다`,
				`${c} 가 돌아왔다`,
			],
			correctChoice: 1,
			questionType: FIXTURE_TYPES[i % FIXTURE_TYPES.length]!,
			difficulty: (i % 3) + 1,
			explanation: `${a} ${b} ${c} 장면의 해설입니다.`,
			// 근거는 Brief 의 문장을 그대로 인용한다. 실제 프롬프트가 요구하는 것과 같다.
			evidence: `${questionSentence(index, pair)} ${answerSentence(index, pair)}.`,
			readRequired: true,
		};
	});
}

/** 픽스처 문항 전부를 통과시키는 검수 결과. */
export const verdictsFor = (questions: { questionNumber: number }[], valid = true) => ({
	results: questions.map((q) => ({
		questionNumber: q.questionNumber,
		valid,
		score: valid ? 90 : 20,
		reason: valid ? "" : "책 내용과 맞지 않습니다.",
		readRequired: true,
	})),
});
