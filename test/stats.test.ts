import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { COOLDOWN_MS } from "../src/services/retry";
import { addChild, signupParent, type Client } from "./helpers";

/**
 * 대시보드 집계(§19).
 *
 * 부모가 보고 싶은 것은 "우리 아이가 책을 읽고 있는가" 다. 그래서 여기서 가장 중요한 숫자는
 * **끝까지 읽은 책 수**이고, 같은 책을 여러 번 통과해도 한 권으로 세어야 한다.
 */
const API_KEY = "sk-test1234567890abcdefghijklmn";

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
]);

const TYPES = ["EVENT", "CHARACTER", "DETAIL", "SEQUENCE", "CAUSE_EFFECT", "ACTION", "EMOTION", "INFERENCE"];
const WORDS = ["가람", "나루", "다솜", "라온", "마루", "바다", "사슴", "아람", "자연", "차오름"];

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
			explanation: `${n}번 장면의 해설입니다.`,
			evidence: `${n}번 장면의 근거입니다.`,
			readRequired: true,
		};
	});
}

const verdictsFor = (questions: { questionNumber: number }[]) => ({
	results: questions.map((q) => ({
		questionNumber: q.questionNumber,
		valid: true,
		score: 90,
		reason: "",
		readRequired: true,
	})),
});

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

async function parentWithKey(): Promise<Client> {
	const { client } = await signupParent();

	fetchMock
		.get("https://api.openai.com")
		.intercept({ path: "/v1/models", method: "GET" })
		.reply(200, { data: [{ id: "gpt-5.6-mini" }] });
	mockResponses({ ok: true });
	await client.request("/api/settings/ai-key", {
		method: "PUT",
		body: { provider: "openai", apiKey: API_KEY },
	});
	await client.request("/api/settings/quiz", {
		method: "PUT",
		body: { questionCount: 5, passCount: 3 },
	});

	return client;
}

/** 책 한 권 + 문항 5개까지 준비한다. */
async function bookWithQuiz(
	parent: Client,
	title: string,
	offset: number,
): Promise<{ bookId: string; quizId: string }> {
	const form = new FormData();
	form.append("cover", new File([PNG], "cover.png", { type: "image/png" }));
	const bookId = (await parent.upload("/api/books", form)).body.data.book.id as string;
	await parent.patch(`/api/books/${bookId}`, { title, author: "황선미" });

	fetchMock
		.get("https://www.googleapis.com")
		.intercept({ path: (p) => p.startsWith("/books/v1/volumes"), method: "GET" })
		.reply(200, {});
	mockResponses({
		title,
		author: "황선미",
		publisher: "사계절",
		isbn13: "",
		publishedAt: "2000",
		targetAge: "초등 고학년",
		description: "이야기.",
		plotSummary: "줄거리가 여기 있습니다.",
		characters: [{ name: "잎싹", role: "암탉" }],
		keyEvents: ["떠난다"],
		sources: [
			{ url: "https://example.com/a", title: "소개", content: "가" },
			{ url: "https://example.com/b", title: "서평", content: "나" },
		],
	});
	await parent.post(`/api/books/${bookId}/search`);

	const quizId = (await parent.post("/api/quizzes", { bookId })).body.data.quiz.id as string;
	const questions = makeQuestions(5, offset);
	mockResponses({ questions });
	mockResponses(verdictsFor(questions));
	await parent.post(`/api/quizzes/${quizId}/generate`);
	await waitForGeneration(parent, quizId);

	return { bookId, quizId };
}

async function waitForGeneration(client: Client, quizId: string, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const detail = await client.get(`/api/quizzes/${quizId}`);
		if (detail.body?.data?.quiz?.status !== "GENERATING") return detail;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("생성이 끝나지 않았습니다");
}

/** 아이가 퀴즈를 푼다. `correct` 가 true 면 통과할 만큼 맞힌다. */
async function play(
	parent: Client,
	child: Awaited<ReturnType<typeof addChild>>,
	quizId: string,
	correct: boolean,
): Promise<string> {
	const assigned = await parent.post(`/api/quizzes/${quizId}/assign`, { childId: child.childId });
	const assignmentId = assigned.body.data.assignment.assignmentId;
	const { attempt } = (await child.client.post("/api/attempts", { assignmentId })).body.data;

	const answers = (await parent.get(`/api/quizzes/${quizId}`)).body.data.questions;
	for (const q of answers) {
		const view = (await child.client.get(`/api/attempts/${attempt.id}`)).body.data.attempt;
		if (view.completedAt) break;

		await child.client.post(`/api/attempts/${attempt.id}/answers`, {
			questionNumber: q.questionNumber,
			selectedChoice: correct ? q.correctChoice : (q.correctChoice % 4) + 1,
		});
	}

	return attempt.id as string;
}

describe("대시보드", { timeout: 40_000 }, () => {
	it("아직 아무것도 안 했으면 0 으로 채워진다", async () => {
		const parent = await parentWithKey();
		const child = await addChild(parent, "성현");

		const view = (await parent.get("/api/dashboard")).body.data;
		expect(view.children).toHaveLength(1);
		expect(view.children[0].name).toBe("성현");
		expect(view.children[0].stats.attempts).toBe(0);
		expect(view.children[0].stats.booksPassed).toBe(0);
		expect(view.children[0].stats.averageScore).toBeNull();
		expect(view.recent).toHaveLength(0);
		expect(view.totals).toEqual({ booksPassed: 0, attempts: 0, passed: 0 });

		// 상세 화면도 열린다
		const summary = (await parent.get(`/api/children/${child.childId}/summary`)).body.data;
		expect(summary.books).toHaveLength(0);
		expect(summary.attempts).toHaveLength(0);
	});

	it("푼 판이 집계와 최근 목록에 들어간다", async () => {
		const parent = await parentWithKey();
		const child = await addChild(parent, "성현");
		const { quizId } = await bookWithQuiz(parent, "마당을 나온 암탉", 0);

		await play(parent, child, quizId, true);

		const view = (await parent.get("/api/dashboard")).body.data;
		const stats = view.children[0].stats;
		expect(stats.attempts).toBe(1);
		expect(stats.completed).toBe(1);
		expect(stats.passed).toBe(1);
		expect(stats.booksPassed).toBe(1);
		expect(stats.booksTried).toBe(1);
		expect(stats.retries).toBe(0);
		expect(stats.averageScore).toBe(100);
		expect(stats.lastPlayedAt).toBeTruthy();

		expect(view.recent).toHaveLength(1);
		expect(view.recent[0].bookTitle).toBe("마당을 나온 암탉");
		expect(view.recent[0].childName).toBe("성현");
		expect(view.recent[0].passed).toBe(true);
		expect(view.totals.booksPassed).toBe(1);
	});

	// 같은 책을 두 번 통과해도 "읽은 책" 은 한 권이다. 이게 어긋나면 부모가 보는 첫 숫자가 틀린다.
	it("재도전으로 통과해도 읽은 책은 한 권으로 센다", async () => {
		const parent = await parentWithKey();
		const child = await addChild(parent, "성현");
		const { bookId, quizId } = await bookWithQuiz(parent, "마당을 나온 암탉", 0);

		// 1회차 실패
		const failed = await play(parent, child, quizId, false);
		await env.DB.prepare("UPDATE quiz_attempts SET completed_at = ? WHERE id = ?")
			.bind(new Date(Date.now() - COOLDOWN_MS - 1000).toISOString(), failed)
			.run();

		// 재도전 → 2회차 생성
		const fresh = makeQuestions(5, 60);
		mockResponses({ questions: fresh });
		mockResponses(verdictsFor(fresh));
		await child.client.post(`/api/attempts/${failed}/retry`);

		const rounds = (await parent.get(`/api/books/${bookId}/quizzes`)).body.data.quizzes;
		await waitForGeneration(parent, rounds[0].id);

		// 2회차 통과
		const nextAssignment = (await child.client.get(`/api/attempts/${failed}`)).body.data.retry
			.nextAssignmentId;
		const { attempt } = (await child.client.post("/api/attempts", { assignmentId: nextAssignment }))
			.body.data;
		const answers = (await parent.get(`/api/quizzes/${rounds[0].id}`)).body.data.questions;
		for (const q of answers) {
			const view = (await child.client.get(`/api/attempts/${attempt.id}`)).body.data.attempt;
			if (view.completedAt) break;
			await child.client.post(`/api/attempts/${attempt.id}/answers`, {
				questionNumber: q.questionNumber,
				selectedChoice: q.correctChoice,
			});
		}

		const stats = (await parent.get("/api/dashboard")).body.data.children[0].stats;
		expect(stats.attempts).toBe(2);
		expect(stats.passed).toBe(1);
		expect(stats.retries).toBe(1); // 2회차 판이 하나
		expect(stats.booksTried).toBe(1);
		expect(stats.booksPassed).toBe(1); // ← 두 판을 풀었어도 한 권

		// 아이 상세에서도 같은 책은 한 줄로 접힌다
		const summary = (await parent.get(`/api/children/${child.childId}/summary`)).body.data;
		expect(summary.books).toHaveLength(1);
		expect(summary.books[0].attempts).toBe(2);
		expect(summary.books[0].passed).toBe(true);
		expect(summary.books[0].bestScore).toBe(100);
		expect(summary.attempts).toHaveLength(2);
	});

	it("아이가 여럿이면 각각 세고 합계도 맞는다", async () => {
		const parent = await parentWithKey();
		const first = await addChild(parent, "성현");
		const second = await addChild(parent, "지우");

		const a = await bookWithQuiz(parent, "마당을 나온 암탉", 0);
		const b = await bookWithQuiz(parent, "몽실 언니", 60);

		await play(parent, first, a.quizId, true);
		await play(parent, second, b.quizId, false);

		const view = (await parent.get("/api/dashboard")).body.data;
		const byName = new Map(view.children.map((c: { name: string }) => [c.name, c]));

		expect((byName.get("성현") as any).stats.booksPassed).toBe(1);
		expect((byName.get("지우") as any).stats.booksPassed).toBe(0);
		expect((byName.get("지우") as any).stats.attempts).toBe(1);

		expect(view.totals).toEqual({ booksPassed: 1, attempts: 2, passed: 1 });
		expect(view.recent).toHaveLength(2);
	});

	it("책 화면에서 그 책의 도전 기록을 본다", async () => {
		const parent = await parentWithKey();
		const child = await addChild(parent, "성현");
		const { bookId, quizId } = await bookWithQuiz(parent, "마당을 나온 암탉", 0);

		await play(parent, child, quizId, true);

		const { attempts } = (await parent.get(`/api/books/${bookId}/history`)).body.data;
		expect(attempts).toHaveLength(1);
		expect(attempts[0].childName).toBe("성현");
		expect(attempts[0].round).toBe(1);
		expect(attempts[0].passed).toBe(true);
	});
});

describe("대시보드 권한", { timeout: 40_000 }, () => {
	it("남의 아이 집계는 볼 수 없다", async () => {
		const parent = await parentWithKey();
		const { client: other } = await signupParent();
		const stranger = await addChild(other, "남의아이");

		expect((await parent.get(`/api/children/${stranger.childId}/summary`)).status).toBe(404);
	});

	it("남의 책 기록은 볼 수 없다", async () => {
		const parent = await parentWithKey();
		const { bookId } = await bookWithQuiz(parent, "마당을 나온 암탉", 0);

		const { client: other } = await signupParent();
		expect((await other.get(`/api/books/${bookId}/history`)).status).toBe(404);
	});

	// 아이에게 형제의 점수를 보여줄 이유가 없다.
	it("아이 계정은 대시보드를 쓸 수 없다", async () => {
		const parent = await parentWithKey();
		const child = await addChild(parent, "성현");

		expect((await child.client.get("/api/dashboard")).status).toBe(403);
		expect((await child.client.get(`/api/children/${child.childId}/summary`)).status).toBe(403);
	});

	// 다른 부모의 아이가 같은 이름이어도 집계가 섞이면 안 된다.
	it("집계는 부모별로 갈린다", async () => {
		const parent = await parentWithKey();
		const child = await addChild(parent, "성현");
		const { quizId } = await bookWithQuiz(parent, "마당을 나온 암탉", 0);
		await play(parent, child, quizId, true);

		const { client: other } = await signupParent();
		await addChild(other, "성현");

		const view = (await other.get("/api/dashboard")).body.data;
		expect(view.children).toHaveLength(1);
		expect(view.children[0].stats.attempts).toBe(0);
		expect(view.recent).toHaveLength(0);
		expect(view.totals.attempts).toBe(0);
	});
});
