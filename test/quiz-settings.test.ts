import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client, FIXTURE_PLOT, addChild, makeQuestions, signupParent, verdictsFor } from "./helpers";

/** 출제 설정(문항 수·통과 개수)과 문제·답 이력. */
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

async function readyBook(): Promise<{ client: Client; bookId: string }> {
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
	const bookId = uploaded.body.data.book.id as string;

	await client.patch(`/api/books/${bookId}`, { title: "마당을 나온 암탉", author: "황선미" });

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
		keyEvents: ["양계장을 떠난다"],
		sources: [
			{ url: "https://example.com/a", title: "소개", content: "잎싹" },
			{ url: "https://example.com/b", title: "서평", content: "성장" },
		],
	});
	await client.post(`/api/books/${bookId}/search`);

	return { client, bookId };
}

async function generateAndWait(client: Client, quizId: string, timeoutMs = 15_000) {
	await client.post(`/api/quizzes/${quizId}/generate`);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const detail = await client.get(`/api/quizzes/${quizId}`);
		if (detail.body?.data?.quiz?.status !== "GENERATING") return detail;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("생성이 끝나지 않았습니다");
}

describe("출제 설정", () => {
	it("기본값은 20문제 중 10개 통과", async () => {
		const { client } = await signupParent();
		const res = await client.get("/api/settings");

		expect(res.body.data.quiz.questionCount).toBe(20);
		expect(res.body.data.quiz.passCount).toBe(10);
	});

	it("문항 수와 통과 개수를 바꿀 수 있다", async () => {
		const { client } = await signupParent();

		const saved = await client.request("/api/settings/quiz", {
			method: "PUT",
			body: { questionCount: 10, passCount: 6 },
		});
		expect(saved.status).toBe(200);

		const view = await client.get("/api/settings");
		expect(view.body.data.quiz.questionCount).toBe(10);
		expect(view.body.data.quiz.passCount).toBe(6);
	});

	it("통과 개수가 문항 수보다 크면 거부한다", async () => {
		const { client } = await signupParent();
		const res = await client.request("/api/settings/quiz", {
			method: "PUT",
			body: { questionCount: 10, passCount: 11 },
		});

		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("통과 개수");
	});

	it("허용 범위를 벗어난 문항 수는 거부한다", async () => {
		const { client } = await signupParent();

		for (const questionCount of [1, 100]) {
			const res = await client.request("/api/settings/quiz", {
				method: "PUT",
				body: { questionCount, passCount: 1 },
			});
			expect(res.status).toBe(400);
			expect(res.body.error.message).toContain("문제 개수");
		}
	});

	it("아이 계정은 출제 설정을 바꿀 수 없다", async () => {
		const { client: parent } = await signupParent();
		const { client: child } = await addChild(parent);

		const res = await child.request("/api/settings/quiz", {
			method: "PUT",
			body: { questionCount: 5, passCount: 1 },
		});
		expect(res.status).toBe(403);
	});
});

describe("설정한 문항 수로 출제", { timeout: 30_000 }, () => {
	it("설정한 개수만큼만 만든다", async () => {
		const { client, bookId } = await readyBook();
		await client.request("/api/settings/quiz", { method: "PUT", body: { questionCount: 8, passCount: 5 } });

		const created = await client.post("/api/quizzes", { bookId });
		const quizId = created.body.data.quiz.id;

		const questions = makeQuestions(8);
		mockResponses({ questions });
		mockResponses(verdictsFor(questions));

		const detail = await generateAndWait(client, quizId);
		expect(detail.body.data.questions).toHaveLength(8);
		expect(detail.body.data.progress.total).toBe(8);
		expect(detail.body.data.quiz.questionCount).toBe(8);
		expect(detail.body.data.quiz.passCount).toBe(5);
	});

	// 설정을 바꿔도 이미 만든 퀴즈의 기준이 따라 바뀌면, 아이가 이미 푼 결과의 합격 여부가 뒤집힌다.
	it("설정을 바꿔도 이미 만든 퀴즈의 기준은 그대로다", async () => {
		const { client, bookId } = await readyBook();
		await client.request("/api/settings/quiz", { method: "PUT", body: { questionCount: 8, passCount: 5 } });

		const created = await client.post("/api/quizzes", { bookId });
		const quizId = created.body.data.quiz.id;

		// 설정을 바꾼 뒤
		await client.request("/api/settings/quiz", { method: "PUT", body: { questionCount: 25, passCount: 20 } });

		const detail = await client.get(`/api/quizzes/${quizId}`);
		expect(detail.body.data.quiz.questionCount).toBe(8);
		expect(detail.body.data.quiz.passCount).toBe(5);
	});
});

describe("문제·답 이력", { timeout: 30_000 }, () => {
	it("생성한 문제가 이력에 남는다", async () => {
		const { client, bookId } = await readyBook();
		await client.request("/api/settings/quiz", { method: "PUT", body: { questionCount: 6, passCount: 4 } });

		const created = await client.post("/api/quizzes", { bookId });
		const questions = makeQuestions(6);
		mockResponses({ questions });
		mockResponses(verdictsFor(questions));
		await generateAndWait(client, created.body.data.quiz.id);

		const history = await client.get("/api/history/questions");
		expect(history.status).toBe(200);
		expect(history.body.data.entries).toHaveLength(6);

		const entry = history.body.data.entries[0];
		expect(entry.action).toBe("AI_GENERATED");
		expect(entry.actorType).toBe("AI");
		expect(entry.bookTitle).toBe("마당을 나온 암탉");
		expect(entry.quizRound).toBe(1);
	});

	it("책으로 걸러낼 수 있다", async () => {
		const { client, bookId } = await readyBook();
		await client.request("/api/settings/quiz", { method: "PUT", body: { questionCount: 5, passCount: 3 } });

		const created = await client.post("/api/quizzes", { bookId });
		const questions = makeQuestions(5);
		mockResponses({ questions });
		mockResponses(verdictsFor(questions));
		await generateAndWait(client, created.body.data.quiz.id);

		const mine = await client.get(`/api/history/questions?bookId=${bookId}`);
		expect(mine.body.data.entries).toHaveLength(5);

		const other = await client.get("/api/history/questions?bookId=00000000-0000-0000-0000-000000000000");
		expect(other.body.data.entries).toHaveLength(0);
	});

	it("다른 부모의 이력은 보이지 않는다", async () => {
		const { client, bookId } = await readyBook();
		await client.request("/api/settings/quiz", { method: "PUT", body: { questionCount: 5, passCount: 3 } });

		const created = await client.post("/api/quizzes", { bookId });
		const questions = makeQuestions(5);
		mockResponses({ questions });
		mockResponses(verdictsFor(questions));
		await generateAndWait(client, created.body.data.quiz.id);

		const { client: other } = await signupParent();
		expect((await other.get("/api/history/questions")).body.data.entries).toHaveLength(0);
		// quizId 를 알아도 남의 것은 못 본다
		expect(
			(await other.get(`/api/history/questions?quizId=${created.body.data.quiz.id}`)).body.data.entries,
		).toHaveLength(0);
	});

	it("아직 푼 답이 없으면 답안 이력은 비어 있다", async () => {
		const { client } = await signupParent();
		const res = await client.get("/api/history/answers");

		expect(res.status).toBe(200);
		expect(res.body.data.entries).toEqual([]);
	});

	it("필터 선택지에 내 책과 내 아이가 나온다", async () => {
		const { client, bookId } = await readyBook();
		await addChild(client, "성현");
		await client.post("/api/quizzes", { bookId });

		const res = await client.get("/api/history/filters");
		expect(res.body.data.books).toHaveLength(1);
		expect(res.body.data.books[0].title).toBe("마당을 나온 암탉");
		expect(res.body.data.children.map((c: { name: string }) => c.name)).toContain("성현");
	});

	it("아이 계정은 이력 API 를 쓸 수 없다", async () => {
		const { client: parent } = await signupParent();
		const { client: child } = await addChild(parent);

		expect((await child.get("/api/history/questions")).status).toBe(403);
		expect((await child.get("/api/history/answers")).status).toBe(403);
		expect((await child.get("/api/history/filters")).status).toBe(403);
	});

	it("답안 이력은 아이가 그때 본 문항 본문을 보여준다", async () => {
		const { client, bookId } = await readyBook();
		await client.request("/api/settings/quiz", { method: "PUT", body: { questionCount: 5, passCount: 3 } });

		const created = await client.post("/api/quizzes", { bookId });
		const quizId = created.body.data.quiz.id as string;
		const questions = makeQuestions(5);
		mockResponses({ questions });
		mockResponses(verdictsFor(questions));
		await generateAndWait(client, quizId);

		// Phase 6 이전이라 아이 풀이 API 가 없다. 답안 행을 직접 만들어 조회 경로만 검증한다.
		const child = await addChild(client, "성현");
		const question = await env.DB.prepare(
			"SELECT id, correct_choice FROM questions WHERE quiz_id = ? ORDER BY question_number LIMIT 1",
		)
			.bind(quizId)
			.first<{ id: string; correct_choice: number }>();
		const version = await env.DB.prepare(
			"SELECT id FROM question_versions WHERE question_id = ?",
		)
			.bind(question!.id)
			.first<{ id: string }>();

		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO quiz_assignments (id, quiz_id, parent_user_id, child_id)
				 VALUES ('as-1', ?, (SELECT parent_user_id FROM quizzes WHERE id = ?), ?)`,
			).bind(quizId, quizId, child.childId),
			env.DB.prepare(
				"INSERT INTO quiz_attempts (id, assignment_id, quiz_id, child_id) VALUES ('at-1', 'as-1', ?, ?)",
			).bind(quizId, child.childId),
			env.DB.prepare(
				`INSERT INTO question_answers
				   (id, attempt_id, question_id, question_version_id, selected_choice, correct_choice, is_correct)
				 VALUES ('an-1', 'at-1', ?, ?, 2, ?, 0)`,
			).bind(question!.id, version!.id, question!.correct_choice),
		]);

		// 답안을 남긴 뒤 문제 본문을 바꿔도 이력에는 그때 본 문장이 남아야 한다(§22).
		await env.DB.prepare("UPDATE questions SET question_text = '부모가 나중에 고친 문장' WHERE id = ?")
			.bind(question!.id)
			.run();

		const res = await client.get("/api/history/answers");
		expect(res.body.data.entries).toHaveLength(1);

		const entry = res.body.data.entries[0];
		expect(entry.childName).toBe("성현");
		expect(entry.isCorrect).toBe(false);
		expect(entry.selectedChoice).toBe(2);
		// 아이가 그때 본 본문이어야 한다 — 부모가 나중에 고친 문장이 섞이면 안 된다(§22)
		expect(entry.questionText).not.toBe("부모가 나중에 고친 문장");
		expect(entry.questionText).toContain("어떻게 되었나요");
	});
});
