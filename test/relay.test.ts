import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client, addChild, signupParent } from "./helpers";

/**
 * 브라우저 릴레이.
 *
 * 부모의 브라우저가 Gemini 를 직접 부르는 경로다. 서버는 요청을 만들어 주고 결과를 판정한다.
 * 여기서 확인할 것은 **경계**다 — 키가 누구에게 나가는지, 클라이언트가 보낸 값을 어디까지
 * 믿는지, 품질 게이트가 여전히 서버에 있는지.
 */
const GEMINI_KEY = "AIzaSyTestKey0123456789abcdefghijklmno";
const OPENAI_KEY = "sk-test1234567890abcdefghijklmn";

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

const TYPES = ["EVENT", "CHARACTER", "DETAIL", "SEQUENCE", "CAUSE_EFFECT", "ACTION", "EMOTION", "INFERENCE"];
const WORDS = [
	"가람", "나루", "다솜", "라온", "마루", "바다", "사슴", "아람", "자연", "차오름",
	"카나리", "타래", "파랑", "하늘", "거북", "노을", "도담", "라일락", "모래", "바람",
	"새벽", "여울", "자작", "초록", "푸름",
];

function makeQuestions(count: number, offset = 0) {
	return Array.from({ length: count }, (_, i) => {
		const n = offset + i + 1;
		return {
			questionNumber: i + 1,
			questionText: `${n}번 장면 ${WORDS[n % WORDS.length]}에서 일어난 일 Q${n}`,
			choices: [`선택지 ${n}-가`, `선택지 ${n}-나`, `선택지 ${n}-다`, `선택지 ${n}-라`],
			correctChoice: 1,
			questionType: TYPES[i % TYPES.length],
			difficulty: (i % 3) + 1,
			explanation: `${n}번 해설`,
			evidence: `${n}번 근거`,
			readRequired: true,
		};
	});
}

/** Gemini 원본 응답 모양. 브라우저는 이걸 그대로 서버에 돌려준다. */
const geminiResponse = (payload: unknown) => ({
	candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: "STOP" }],
});

const verdictsFor = (questions: { questionNumber: number }[], valid = true) => ({
	results: questions.map((q) => ({
		questionNumber: q.questionNumber,
		valid,
		score: valid ? 90 : 20,
		reason: valid ? "" : "책 내용과 맞지 않습니다.",
		readRequired: true,
	})),
});

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

/**
 * Gemini 키를 등록한 부모.
 *
 * 서버는 Gemini 를 부를 수 없으므로(지역 차단) 키 저장 때 브라우저가 조회해 온 모델
 * 목록을 그대로 받는다. 인터셉터 없이 저장되는 것이 그 증거다.
 */
async function parentWithGemini(models = ["gemini-3.5-flash"]): Promise<Client> {
	const { client } = await signupParent();
	await client.request("/api/settings/ai-key", {
		method: "PUT",
		body: { provider: "gemini", apiKey: GEMINI_KEY, models },
	});
	return client;
}

async function bookReadyForQuiz(client: Client): Promise<string> {
	const form = new FormData();
	form.append("cover", new File([PNG], "cover.png", { type: "image/png" }));
	const uploaded = await client.upload("/api/books", form);
	const bookId = uploaded.body.data.book.id as string;

	await client.patch(`/api/books/${bookId}`, { title: "마당을 나온 암탉", author: "황선미" });

	// 조사 결과를 브라우저 릴레이로 넣는다 — Brief 가 생겨야 퀴즈를 만들 수 있다.
	fetchMock
		.get("https://www.googleapis.com")
		.intercept({ path: (p) => p.startsWith("/books/v1/volumes"), method: "GET" })
		.reply(200, {}); // apply 단계에서 출처·병합을 위해 한 번 조회한다

	await client.post("/api/ai/apply", {
		kind: "research",
		bookId,
		groundingUsed: true,
		response: geminiResponse({
			title: "마당을 나온 암탉",
			author: "황선미",
			publisher: "사계절",
			isbn13: "",
			publishedAt: "2000",
			targetAge: "초등 고학년",
			description: "양계장을 나온 암탉 이야기.",
			plotSummary: "잎싹이 양계장을 나와 초록머리를 기른다.",
			characters: [{ name: "잎싹", role: "암탉" }],
			keyEvents: ["양계장을 떠난다"],
			sources: [
				{ url: "https://example.com/a", title: "소개", content: "잎싹" },
				{ url: "https://example.com/b", title: "서평", content: "성장" },
			],
		}),
	});

	return bookId;
}

describe("자격증명 노출 경계", () => {
	it("Gemini 를 쓰는 부모에게만 키를 내려준다", async () => {
		const client = await parentWithGemini();
		const res = await client.get("/api/ai/credential");

		expect(res.status).toBe(200);
		expect(res.body.data.apiKey).toBe(GEMINI_KEY);
		expect(res.body.data.model).toBe("gemini-3.5-flash");
	});

	// 서버에서 부를 수 있는 제공자는 키를 내려보낼 이유가 없다.
	it("OpenAI 를 쓰는 부모에게는 키를 내려주지 않는다", async () => {
		const { client } = await signupParent();
		fetchMock
			.get("https://api.openai.com")
			.intercept({ path: "/v1/models", method: "GET" })
			.reply(200, { data: [{ id: "gpt-5.6-mini" }] });
		fetchMock
			.get("https://api.openai.com")
			.intercept({ path: "/v1/responses", method: "POST" })
			.reply(200, { status: "completed", output: [] });
		await client.request("/api/settings/ai-key", {
			method: "PUT",
			body: { provider: "openai", apiKey: OPENAI_KEY },
		});

		const res = await client.get("/api/ai/credential");
		expect(res.status).toBe(403);
	});

	it("아이 계정은 자격증명도 릴레이도 쓸 수 없다", async () => {
		const parent = await parentWithGemini();
		const { client: child } = await addChild(parent);

		expect((await child.get("/api/ai/credential")).status).toBe(403);
		expect((await child.post("/api/ai/plan", { kind: "identify", bookId: "x" })).status).toBe(403);
		expect((await child.post("/api/ai/apply", { kind: "identify", bookId: "x" })).status).toBe(403);
	});

	it("로그인하지 않으면 키를 받을 수 없다", async () => {
		const { Client: Anon } = await import("./helpers");
		const anon = new Anon("10.7.7.7");
		expect((await anon.get("/api/ai/credential")).status).toBe(401);
	});

	it("키가 없으면 안내한다", async () => {
		const { client } = await signupParent();
		const res = await client.get("/api/ai/credential");
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("등록");
	});
});

describe("표지 식별 릴레이", () => {
	it("브라우저가 가져온 응답을 서버가 해석해 반영한다", async () => {
		const client = await parentWithGemini();
		const form = new FormData();
		form.append("cover", new File([PNG], "cover.png", { type: "image/png" }));
		const bookId = (await client.upload("/api/books", form)).body.data.book.id;

		// 1) 서버가 요청을 만들어 준다 — 프롬프트·스키마가 여기 담긴다
		const plan = await client.post("/api/ai/plan", { kind: "identify", bookId });
		expect(plan.status).toBe(200);
		expect(plan.body.data.url).toContain("generativelanguage.googleapis.com");
		expect(plan.body.data.body.generationConfig.responseSchema.type).toBe("OBJECT");
		// 이미지가 본문에 실려 브라우저는 표지를 따로 챙기지 않아도 된다
		expect(JSON.stringify(plan.body.data.body)).toContain("inline_data");

		// 2) 브라우저가 받아 온 원본 응답을 그대로 돌려준다
		const applied = await client.post("/api/ai/apply", {
			kind: "identify",
			bookId,
			response: geminiResponse({
				title: "마당을 나온 암탉",
				author: "황선미",
				publisher: "사계절",
				isbn: "9788958281252",
				series: "",
				confidence: 0.93,
			}),
		});

		expect(applied.status).toBe(200);
		expect(applied.body.data.book.author).toBe("황선미");
		expect(applied.body.data.book.isbn13).toBe("9788958281252");
		expect(applied.body.data.needsReview).toBe(false);
	});
});

/**
 * Gemini 는 인기 모델이 자주 503 을 낸다(실측). 서버 호출 경로에는 폴백이 있는데 릴레이에만
 * 없으면 같은 상황이 부모에게는 그냥 실패로 보인다.
 *
 * 브라우저는 모델을 고르지 않는다 — "이건 안 되더라" 만 avoid 로 알려주고 다음 모델은
 * 서버가 정한다. 여기서 확인하는 것은 서버 쪽 절반이다.
 */
describe("릴레이 모델 폴백", () => {
	async function parentWithBook() {
		const client = await parentWithGemini(["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"]);
		const form = new FormData();
		form.append("cover", new File([PNG], "cover.png", { type: "image/png" }));
		const bookId = (await client.upload("/api/books", form)).body.data.book.id;
		return { client, bookId };
	}

	it("응답하지 않은 모델을 빼고 다음 모델로 계획을 다시 만든다", async () => {
		const { client, bookId } = await parentWithBook();

		const first = await client.post("/api/ai/plan", { kind: "identify", bookId });
		expect(first.body.data.model).toBe("gemini-3.5-flash");
		expect(first.body.data.modelNotice).toBeNull();

		const second = await client.post("/api/ai/plan", {
			kind: "identify",
			bookId,
			avoid: ["gemini-3.5-flash"],
		});

		expect(second.status).toBe(200);
		expect(second.body.data.model).toBe("gemini-3.5-flash-lite");
		expect(second.body.data.url).toContain("gemini-3.5-flash-lite");
		// 조용히 바꾸지 않는다. 결과가 달라 보일 수 있으니 부모에게 알린다.
		expect(second.body.data.modelNotice).toContain("gemini-3.5-flash");
	});

	// 브라우저가 avoid 를 계속 늘리며 무한히 되물어 볼 수 있으면 안 된다.
	it("후보를 다 쓰면 거절한다", async () => {
		const { client, bookId } = await parentWithBook();

		const res = await client.post("/api/ai/plan", {
			kind: "identify",
			bookId,
			avoid: ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"],
		});

		expect(res.status).toBe(502);
		expect(res.body.error.code).toBe("ai_failed");
	});
});

describe("문제 생성 릴레이", { timeout: 30_000 }, () => {
	it("서버가 라운드를 이끌고 통과분만 저장한다", async () => {
		const client = await parentWithGemini();
		const bookId = await bookReadyForQuiz(client);
		await client.request("/api/settings/quiz", { method: "PUT", body: { questionCount: 6, passCount: 4 } });
		const quizId = (await client.post("/api/quizzes", { bookId })).body.data.quiz.id;

		// 1) 몇 개가 필요한지 서버가 정한다
		const plan = await client.post("/api/ai/plan", { kind: "generate", quizId, rejected: [] });
		expect(plan.body.data.done).toBe(false);
		expect(plan.body.data.need).toBe(6);

		// 2) 브라우저가 만든 문항을 서버가 사후검사한다
		const questions = makeQuestions(6);
		const validatePlan = await client.post("/api/ai/plan", {
			kind: "validate",
			quizId,
			response: geminiResponse({ questions }),
		});
		expect(validatePlan.body.data.questions).toHaveLength(6);
		expect(validatePlan.body.data.url).toContain(":generateContent");

		// 3) 검수 결과를 적용한다
		const accepted = await client.post("/api/ai/apply", {
			kind: "accept",
			quizId,
			questions: validatePlan.body.data.questions,
			response: geminiResponse(verdictsFor(questions)),
		});

		expect(accepted.body.data.accepted).toBe(6);
		expect(accepted.body.data.done).toBe(true);

		const detail = await client.get(`/api/quizzes/${quizId}`);
		expect(detail.body.data.questions).toHaveLength(6);
		// 서버가 도는 경로와 마찬가지로 검수 대기로 넘어간다. DRAFT 에 머물면 목록에서
		// "아직 안 만든 퀴즈" 와 구분되지 않는다.
		expect(detail.body.data.quiz.status).toBe("REVIEW");
	});

	// 클라이언트가 보낸 문항을 그대로 믿으면 §7·§9·§10 게이트가 무의미해진다.
	it("클라이언트가 규칙을 어긴 문항을 보내도 서버가 걸러낸다", async () => {
		const client = await parentWithGemini();
		const bookId = await bookReadyForQuiz(client);
		await client.request("/api/settings/quiz", { method: "PUT", body: { questionCount: 6, passCount: 4 } });
		const quizId = (await client.post("/api/quizzes", { bookId })).body.data.quiz.id;

		const good = makeQuestions(3);
		const bad = [
			// 선택지가 서로 같다
			{ ...makeQuestions(1, 50)[0]!, choices: ["가", "가 ", "다", "라"] },
			// 근거가 없다
			{ ...makeQuestions(1, 60)[0]!, evidence: "  " },
			// 책 제목을 그대로 묻는다
			{ ...makeQuestions(1, 70)[0]!, questionText: "마당을 나온 암탉의 주제는 무엇인가요" },
		].map((q, i) => ({ ...q, questionNumber: 4 + i }));

		const all = [...good, ...bad];
		const accepted = await client.post("/api/ai/apply", {
			kind: "accept",
			quizId,
			questions: all,
			// 모델이 전부 통과라고 해도
			response: geminiResponse(verdictsFor(all)),
		});

		// 서버 사후검사를 통과한 3개만 저장된다
		expect(accepted.body.data.accepted).toBe(3);
		expect(accepted.body.data.rejected.length).toBe(3);
	});

	it("검수에서 탈락하면 저장하지 않는다", async () => {
		const client = await parentWithGemini();
		const bookId = await bookReadyForQuiz(client);
		await client.request("/api/settings/quiz", { method: "PUT", body: { questionCount: 6, passCount: 4 } });
		const quizId = (await client.post("/api/quizzes", { bookId })).body.data.quiz.id;

		const questions = makeQuestions(6);
		const accepted = await client.post("/api/ai/apply", {
			kind: "accept",
			quizId,
			questions,
			response: geminiResponse(verdictsFor(questions, false)),
		});

		expect(accepted.body.data.accepted).toBe(0);
		expect((await client.get(`/api/quizzes/${quizId}`)).body.data.questions).toHaveLength(0);
	});

	it("목표를 채우면 더 부르지 않는다", async () => {
		const client = await parentWithGemini();
		const bookId = await bookReadyForQuiz(client);
		await client.request("/api/settings/quiz", { method: "PUT", body: { questionCount: 5, passCount: 3 } });
		const quizId = (await client.post("/api/quizzes", { bookId })).body.data.quiz.id;

		const questions = makeQuestions(5);
		await client.post("/api/ai/apply", {
			kind: "accept",
			quizId,
			questions,
			response: geminiResponse(verdictsFor(questions)),
		});

		const plan = await client.post("/api/ai/plan", { kind: "generate", quizId, rejected: [] });
		expect(plan.body.data.done).toBe(true);
		expect(plan.body.data.url).toBeUndefined();
	});

	it("다른 부모의 퀴즈에는 릴레이를 걸 수 없다", async () => {
		const client = await parentWithGemini();
		const bookId = await bookReadyForQuiz(client);
		const quizId = (await client.post("/api/quizzes", { bookId })).body.data.quiz.id;

		const other = await parentWithGemini();
		expect((await other.post("/api/ai/plan", { kind: "generate", quizId, rejected: [] })).status).toBe(404);
		expect(
			(await other.post("/api/ai/apply", { kind: "accept", quizId, questions: [], response: {} })).status,
		).toBe(404);
	});
});

describe("정답 위치 균등화는 서버가 한다", () => {
	it("클라이언트가 전부 1번을 정답으로 보내도 고르게 편다", async () => {
		const client = await parentWithGemini();
		const bookId = await bookReadyForQuiz(client);
		await client.request("/api/settings/quiz", { method: "PUT", body: { questionCount: 8, passCount: 5 } });
		const quizId = (await client.post("/api/quizzes", { bookId })).body.data.quiz.id;

		const questions = makeQuestions(8).map((q) => ({ ...q, correctChoice: 1 }));
		await client.post("/api/ai/apply", {
			kind: "accept",
			quizId,
			questions,
			response: geminiResponse(verdictsFor(questions)),
		});

		const { results } = await env.DB.prepare(
			"SELECT correct_choice AS c, COUNT(*) AS n FROM questions WHERE quiz_id = ? GROUP BY correct_choice",
		)
			.bind(quizId)
			.all<{ c: number; n: number }>();

		expect(results).toHaveLength(4);
		for (const row of results) expect(row.n).toBe(2);
	});
});
