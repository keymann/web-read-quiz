import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { balanceAnswerPositions, screen } from "../src/services/question-checks";
import { Client, FIXTURE_PLOT, addChild, makeQuestions, signupParent, verdictsFor } from "./helpers";

/**
 * 문제 생성 파이프라인. OpenAI 는 fetchMock 으로 가로챈다.
 *
 * 생성은 `ctx.waitUntil` 로 백그라운드에서 돈다. `SELF.fetch` 는 202 를 받은 시점에 돌아오고
 * 백그라운드 작업은 그 뒤에도 계속되므로, 결과를 읽기 전에 상태가 GENERATING 을 벗어날 때까지
 * 기다려야 한다.
 */
const API_KEY = "sk-test1234567890abcdefghijklmn";

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);






beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

function mockResponses(payload: unknown, times = 1) {
	fetchMock
		.get("https://api.openai.com")
		.intercept({ path: "/v1/responses", method: "POST" })
		.reply(200, {
			status: "completed",
			output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(payload) }] }],
		})
		.times(times);
}

function mockModels(times = 1) {
	fetchMock
		.get("https://api.openai.com")
		.intercept({ path: "/v1/models", method: "GET" })
		.reply(200, { data: [{ id: "gpt-5.6-mini" }] })
		.times(times);
}

/** 키 등록 → 책 등록 → 분석 → 검색까지 마친 상태를 만든다. */
async function readyBook(): Promise<{ client: Client; bookId: string }> {
	const { client } = await signupParent();

	mockModels(1);
	mockResponses({ ok: true }); // 키 저장 시 추론 확인
	await client.request("/api/settings/ai-key", {
		method: "PUT",
		body: { provider: "openai", apiKey: API_KEY },
	});

	const form = new FormData();
	form.append("cover", new File([PNG], "cover.png", { type: "image/png" }));
	const uploaded = await client.upload("/api/books", form);
	const bookId = uploaded.body.data.book.id as string;

	await client.patch(`/api/books/${bookId}`, { title: "마당을 나온 암탉", author: "황선미" });

	// 검색 — 서지 API 는 비우고 웹 출처 2건을 만든다
	fetchMock
		.get("https://www.googleapis.com")
		.intercept({ path: (p) => p.startsWith("/books/v1/volumes"), method: "GET" })
		.reply(200, {});
	mockResponses({
		title: "마당을 나온 암탉",
		author: "황선미",
		publisher: "사계절",
		isbn13: "",
		publishedAt: "2000",
		targetAge: "초등 고학년",
		description: "양계장을 나온 암탉 이야기.",
		plotSummary: FIXTURE_PLOT,
		characters: [{ name: "잎싹", role: "암탉" }],
		keyEvents: ["양계장을 떠난다", "알을 품는다"],
		sources: [
			{ url: "https://example.com/a", title: "소개", content: "잎싹" },
			{ url: "https://example.com/b", title: "서평", content: "성장" },
		],
	});
	await client.post(`/api/books/${bookId}/search`);

	return { client, bookId };
}

/** 백그라운드 생성이 끝날 때까지 기다린 뒤 상세를 돌려준다. */
async function generateAndWait(client: Client, quizId: string, timeoutMs = 15_000) {
	const started = await client.post(`/api/quizzes/${quizId}/generate`);
	expect(started.status).toBe(202);

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const detail = await client.get(`/api/quizzes/${quizId}`);
		if (detail.body?.data?.quiz?.status !== "GENERATING") return detail;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("생성이 끝나지 않았습니다");
}

async function createQuiz(client: Client, bookId: string): Promise<string> {
	const res = await client.post("/api/quizzes", { bookId });
	expect(res.status).toBe(201);
	return res.body.data.quiz.id as string;
}

describe("문제 생성", { timeout: 30_000 }, () => {
	it("정상 경로는 AI 호출 2회로 20문제를 만든다", async () => {
		const { client, bookId } = await readyBook();
		const quizId = await createQuiz(client, bookId);

		const questions = makeQuestions(20);
		mockResponses({ questions }); // 1) 생성
		mockResponses(verdictsFor(questions)); // 2) 검증

		const detail = await generateAndWait(client, quizId);
		expect(detail.body.data.quiz.status).toBe("REVIEW");
		expect(detail.body.data.questions).toHaveLength(20);
		expect(detail.body.data.quiz.error).toBeNull();
	});

	it("탈락한 문항 수만큼만 다시 만든다", async () => {
		const { client, bookId } = await readyBook();
		const quizId = await createQuiz(client, bookId);

		const first = makeQuestions(20);
		mockResponses({ questions: first });
		// 앞 5개만 통과시킨다
		mockResponses({
			results: first.map((q, i) => ({
				questionNumber: q.questionNumber,
				valid: i < 5,
				score: i < 5 ? 90 : 30,
				reason: i < 5 ? "" : "근거가 약합니다.",
				readRequired: true,
			})),
		});

		// 2라운드에서 나머지 15개를 채운다
		const second = makeQuestions(15, 100);
		mockResponses({ questions: second });
		mockResponses(verdictsFor(second));

		const detail = await generateAndWait(client, quizId);
		expect(detail.body.data.questions).toHaveLength(20);
	});

	it("검수를 통과한 문제가 없으면 사유를 남기고 DRAFT 로 되돌린다", async () => {
		const { client, bookId } = await readyBook();
		const quizId = await createQuiz(client, bookId);

		// 3라운드 모두 전멸
		for (let round = 0; round < 3; round++) {
			const questions = makeQuestions(20, round * 100);
			mockResponses({ questions });
			mockResponses(verdictsFor(questions, false));
		}

		const detail = await generateAndWait(client, quizId);
		expect(detail.body.data.quiz.status).toBe("DRAFT");
		expect(detail.body.data.quiz.error).toContain("검수를 통과한 문제가 없");
		expect(detail.body.data.questions).toHaveLength(0);
	});

	it("문항마다 버전·이력·검증기록이 함께 남는다", async () => {
		const { client, bookId } = await readyBook();
		const quizId = await createQuiz(client, bookId);

		const questions = makeQuestions(20);
		mockResponses({ questions });
		mockResponses(verdictsFor(questions));
		await generateAndWait(client, quizId);

		const counts = await env.DB.prepare(
			`SELECT
			   (SELECT COUNT(*) FROM questions WHERE quiz_id = ?1) AS q,
			   (SELECT COUNT(*) FROM question_versions v JOIN questions q2 ON q2.id = v.question_id WHERE q2.quiz_id = ?1) AS v,
			   (SELECT COUNT(*) FROM question_histories h JOIN questions q3 ON q3.id = h.question_id WHERE q3.quiz_id = ?1) AS h,
			   (SELECT COUNT(*) FROM question_validations x JOIN questions q4 ON q4.id = x.question_id WHERE q4.quiz_id = ?1) AS x`,
		)
			.bind(quizId)
			.first<{ q: number; v: number; h: number; x: number }>();

		expect(counts).toEqual({ q: 20, v: 20, h: 20, x: 20 });

		const history = await env.DB.prepare(
			"SELECT action, actor_type FROM question_histories LIMIT 1",
		).first<{ action: string; actor_type: string }>();
		expect(history).toEqual({ action: "AI_GENERATED", actor_type: "AI" });
	});

	it("정답 위치가 한쪽에 몰리지 않는다", async () => {
		const { client, bookId } = await readyBook();
		const quizId = await createQuiz(client, bookId);

		// 모델이 전부 1번을 정답으로 내놓아도 서버가 고르게 편다(§9-10)
		const questions = makeQuestions(20).map((q) => ({ ...q, correctChoice: 1 }));
		mockResponses({ questions });
		mockResponses(verdictsFor(questions));
		await generateAndWait(client, quizId);

		const { results } = await env.DB.prepare(
			"SELECT correct_choice AS c, COUNT(*) AS n FROM questions WHERE quiz_id = ? GROUP BY correct_choice",
		)
			.bind(quizId)
			.all<{ c: number; n: number }>();

		expect(results).toHaveLength(4);
		for (const row of results) expect(row.n).toBe(5);
	});

	it("책 정보(Brief)가 없으면 퀴즈를 만들 수 없다", async () => {
		const { client } = await signupParent();
		mockModels(1);
		mockResponses({ ok: true });
		await client.request("/api/settings/ai-key", {
			method: "PUT",
			body: { provider: "openai", apiKey: API_KEY },
		});

		const form = new FormData();
		form.append("cover", new File([PNG], "cover.png", { type: "image/png" }));
		const uploaded = await client.upload("/api/books", form);

		const res = await client.post("/api/quizzes", { bookId: uploaded.body.data.book.id });
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("책 정보");
	});
});

describe("생성 권한·상태", () => {
	it("다른 부모의 퀴즈는 조회·생성할 수 없다", async () => {
		const { client, bookId } = await readyBook();
		const quizId = await createQuiz(client, bookId);

		const { client: other } = await signupParent();
		expect((await other.get(`/api/quizzes/${quizId}`)).status).toBe(404);
		expect((await other.post(`/api/quizzes/${quizId}/generate`)).status).toBe(404);
	});

	it("아이 계정은 퀴즈 API 를 쓸 수 없다", async () => {
		const { client, bookId } = await readyBook();
		const quizId = await createQuiz(client, bookId);

		const { client: child } = await addChild(client);
		expect((await child.get(`/api/quizzes/${quizId}`)).status).toBe(403);
	});

	it("같은 책의 퀴즈는 회차가 올라간다", async () => {
		const { client, bookId } = await readyBook();
		await createQuiz(client, bookId);
		const second = await client.post("/api/quizzes", { bookId });

		expect(second.body.data.quiz.round).toBe(2);
	});
});

describe("서버 사후 검사", () => {
	const context = { accepted: [], title: "마당을 나온 암탉", author: "황선미" };
	const base = makeQuestions(1)[0]!;

	it("같은 선택지가 있으면 탈락시킨다", () => {
		const result = screen([{ ...base, choices: ["가", "가 ", "다", "라"] }], context);
		expect(result.passed).toHaveLength(0);
		expect(result.failed[0]!.reason).toContain("같은 선택지");
	});

	it("근거가 비어 있으면 탈락시킨다", () => {
		const result = screen([{ ...base, evidence: "  " }], context);
		expect(result.failed[0]!.reason).toContain("근거");
	});

	it("책 제목이나 지은이를 묻는 문제는 탈락시킨다(§7)", () => {
		const byTitle = screen([{ ...base, questionText: "마당을 나온 암탉의 주제는 무엇인가요" }], context);
		expect(byTitle.failed[0]!.reason).toContain("제목");

		const byAuthor = screen([{ ...base, questionText: "황선미 작가가 말하려는 것은 무엇인가요" }], context);
		expect(byAuthor.failed[0]!.reason).toContain("지은이");
	});

	it("이미 만든 문제와 겹치면 탈락시킨다", () => {
		const result = screen([base], { ...context, accepted: [base.questionText] });
		expect(result.failed[0]!.reason).toContain("겹칩니다");
	});

	it("정답 위치를 고르게 펴도 정답 내용은 그대로다", () => {
		const questions = makeQuestions(20).map((q) => ({ ...q, correctChoice: 1 }));
		const answers = questions.map((q) => q.choices[0]!);

		const balanced = balanceAnswerPositions(questions);

		balanced.forEach((q, i) => {
			expect(q.choices[q.correctChoice - 1]).toBe(answers[i]);
			expect([...q.choices].sort()).toEqual([...questions[i]!.choices].sort());
		});

		const counts = [1, 2, 3, 4].map((n) => balanced.filter((q) => q.correctChoice === n).length);
		expect(counts).toEqual([5, 5, 5, 5]);
	});
});
