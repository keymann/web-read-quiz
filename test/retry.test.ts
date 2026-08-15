import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { COOLDOWN_MS } from "../src/services/retry";
import { addChild, signupParent, type Client } from "./helpers";

/**
 * 재도전(§18).
 *
 * 통과하지 못하면 20분 뒤에, **새 문제로** 다시 도전한다. 같은 문제를 다시 주면 답을 외워서
 * 통과할 수 있어 "책을 읽었는지 확인한다" 는 목적이 무너진다.
 *
 * 20분을 실제로 기다릴 수는 없으므로 `completed_at` 을 과거로 밀어 대기가 끝난 상태를 만든다.
 * 쿨다운을 서버가 **저장된 시각으로** 계산한다는 사실 자체를 이용하는 것이라, 이 조작이
 * 통하는 것이 곧 클라이언트 시계가 소용없다는 증거이기도 하다.
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

/** 5문제 중 3개 통과. 아이가 전부 틀려 실패한 판까지 만들어 둔다. */
async function failedAttempt(): Promise<{
	parent: Client;
	child: Awaited<ReturnType<typeof addChild>>;
	attemptId: string;
	bookId: string;
}> {
	const { client: parent } = await signupParent();

	fetchMock
		.get("https://api.openai.com")
		.intercept({ path: "/v1/models", method: "GET" })
		.reply(200, { data: [{ id: "gpt-5.6-mini" }] });
	mockResponses({ ok: true });
	await parent.request("/api/settings/ai-key", {
		method: "PUT",
		body: { provider: "openai", apiKey: API_KEY },
	});
	await parent.request("/api/settings/quiz", {
		method: "PUT",
		body: { questionCount: 5, passCount: 3 },
	});

	const form = new FormData();
	form.append("cover", new File([PNG], "cover.png", { type: "image/png" }));
	const bookId = (await parent.upload("/api/books", form)).body.data.book.id as string;
	await parent.patch(`/api/books/${bookId}`, { title: "마당을 나온 암탉", author: "황선미" });

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
		plotSummary: "잎싹이 양계장을 나와 초록머리를 기른다.",
		characters: [{ name: "잎싹", role: "암탉" }],
		keyEvents: ["양계장을 떠난다", "알을 품는다"],
		sources: [
			{ url: "https://example.com/a", title: "소개", content: "잎싹" },
			{ url: "https://example.com/b", title: "서평", content: "성장" },
		],
	});
	await parent.post(`/api/books/${bookId}/search`);

	const quizId = (await parent.post("/api/quizzes", { bookId })).body.data.quiz.id as string;
	const questions = makeQuestions(5);
	mockResponses({ questions });
	mockResponses(verdictsFor(questions));
	await parent.post(`/api/quizzes/${quizId}/generate`);
	await waitForGeneration(parent, quizId);

	const child = await addChild(parent, "성현");
	const assigned = await parent.post(`/api/quizzes/${quizId}/assign`, { childId: child.childId });
	const assignmentId = assigned.body.data.assignment.assignmentId;

	const { attempt } = (await child.client.post("/api/attempts", { assignmentId })).body.data;

	// 전부 틀린다
	const answers = (await parent.get(`/api/quizzes/${quizId}`)).body.data.questions;
	for (const q of answers) {
		await child.client.post(`/api/attempts/${attempt.id}/answers`, {
			questionNumber: q.questionNumber,
			selectedChoice: (q.correctChoice % 4) + 1,
		});
	}

	return { parent, child, attemptId: attempt.id, bookId };
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

/** 쿨다운이 끝난 상태를 만든다. 서버가 저장된 `completed_at` 으로 계산하기 때문에 통한다. */
async function expireCooldown(attemptId: string) {
	const past = new Date(Date.now() - COOLDOWN_MS - 1000).toISOString();
	await env.DB.prepare("UPDATE quiz_attempts SET completed_at = ? WHERE id = ?")
		.bind(past, attemptId)
		.run();
}

describe("재도전", { timeout: 40_000 }, () => {
	it("실패 직후에는 기다려야 한다", async () => {
		const { child, attemptId } = await failedAttempt();

		const { retry } = (await child.client.get(`/api/attempts/${attemptId}`)).body.data;
		expect(retry.status).toBe("COOLDOWN");
		// 20분에서 거의 줄지 않은 값이어야 한다
		expect(retry.waitSeconds).toBeGreaterThan(19 * 60);
		expect(retry.waitSeconds).toBeLessThanOrEqual(20 * 60);

		const res = await child.client.post(`/api/attempts/${attemptId}/retry`);
		expect(res.status).toBe(409);
		expect(res.body.error.message).toContain("분 뒤");
	});

	it("통과한 판은 재도전할 것이 없다", async () => {
		const { parent, child, attemptId } = await failedAttempt();
		// 통과한 판을 하나 만들기 위해 이 판을 통과로 바꾼다
		await env.DB.prepare("UPDATE quiz_attempts SET passed = 1 WHERE id = ?").bind(attemptId).run();

		const { retry } = (await child.client.get(`/api/attempts/${attemptId}`)).body.data;
		expect(retry.status).toBe("PASSED");
		expect((await child.client.post(`/api/attempts/${attemptId}/retry`)).status).toBe(409);

		// 새 회차가 만들어지지 않았다
		const book = (await parent.get("/api/books")).body.data.books[0];
		const rounds = (await parent.get(`/api/books/${book.id}/quizzes`)).body.data.quizzes;
		expect(rounds).toHaveLength(1);
	});

	it("20분이 지나면 새 회차와 새 문제가 만들어진다", async () => {
		const { parent, child, attemptId, bookId } = await failedAttempt();
		await expireCooldown(attemptId);

		const ready = (await child.client.get(`/api/attempts/${attemptId}`)).body.data.retry;
		expect(ready.status).toBe("READY");
		expect(ready.waitSeconds).toBe(0);

		// 서버가 직접 부를 수 있는 제공자(OpenAI)라 백그라운드로 생성이 돈다
		const fresh = makeQuestions(5, 50);
		mockResponses({ questions: fresh });
		mockResponses(verdictsFor(fresh));

		const started = await child.client.post(`/api/attempts/${attemptId}/retry`);
		expect(started.status).toBe(201);
		expect(started.body.data.retry.status).toBe("PREPARING");
		expect(started.body.data.retry.nextAssignmentId).toBeTruthy();

		// 2회차가 생겼고 출제 기준은 1회차와 같다
		const rounds = (await parent.get(`/api/books/${bookId}/quizzes`)).body.data.quizzes;
		expect(rounds).toHaveLength(2);
		expect(rounds[0].round).toBe(2);
		expect(rounds[0].questionCount).toBe(5);

		await waitForGeneration(parent, rounds[0].id);

		const done = (await child.client.get(`/api/attempts/${attemptId}`)).body.data.retry;
		expect(done.status).toBe("WAITING");
		expect(done.prepared).toBe(5);

		// 새 판을 시작하면 **새 문제**가 나온다
		const next = (
			await child.client.post("/api/attempts", { assignmentId: done.nextAssignmentId })
		).body.data.attempt;
		expect(next.id).not.toBe(attemptId);
		expect(next.questions).toHaveLength(5);

		const oldTexts = (await child.client.get(`/api/attempts/${attemptId}`)).body.data.attempt.questions.map(
			(q: { questionText: string }) => q.questionText,
		);
		const newTexts = next.questions.map((q: { questionText: string }) => q.questionText);
		expect(newTexts.some((t: string) => oldTexts.includes(t))).toBe(false);
	});

	// 지난 판의 문항과 답은 그대로 남아야 한다(§22).
	it("지난 판의 기록은 그대로 조회된다", async () => {
		const { parent, child, attemptId, bookId } = await failedAttempt();
		const before = (await child.client.get(`/api/attempts/${attemptId}`)).body.data.attempt;
		await expireCooldown(attemptId);

		const fresh = makeQuestions(5, 50);
		mockResponses({ questions: fresh });
		mockResponses(verdictsFor(fresh));
		await child.client.post(`/api/attempts/${attemptId}/retry`);

		const rounds = (await parent.get(`/api/books/${bookId}/quizzes`)).body.data.quizzes;
		await waitForGeneration(parent, rounds[0].id);

		const after = (await child.client.get(`/api/attempts/${attemptId}`)).body.data.attempt;
		expect(after.questions.map((q: { questionText: string }) => q.questionText)).toEqual(
			before.questions.map((q: { questionText: string }) => q.questionText),
		);
		expect(after.correctCount).toBe(before.correctCount);
		expect(after.score).toBe(before.score);

		// 아이의 기록에는 두 판이 모두 남는다
		expect((await child.client.get("/api/my/attempts")).body.data.attempts.length).toBeGreaterThanOrEqual(1);
	});

	// 두 번 누르면 회차가 둘로 늘어난다 — AI 호출이 두 배가 되고 아이는 어느 것을 풀지 모른다.
	it("두 번 눌러도 회차가 하나만 생긴다", async () => {
		const { parent, child, attemptId, bookId } = await failedAttempt();
		await expireCooldown(attemptId);

		const fresh = makeQuestions(5, 50);
		mockResponses({ questions: fresh });
		mockResponses(verdictsFor(fresh));

		const first = await child.client.post(`/api/attempts/${attemptId}/retry`);
		const second = await child.client.post(`/api/attempts/${attemptId}/retry`);

		expect(second.status).toBe(201);
		expect(second.body.data.retry.nextAssignmentId).toBe(first.body.data.retry.nextAssignmentId);

		const rounds = (await parent.get(`/api/books/${bookId}/quizzes`)).body.data.quizzes;
		expect(rounds).toHaveLength(2);

		await waitForGeneration(parent, rounds[0].id);
	});

	/**
	 * Gemini 는 서버가 부를 수 없어(지역 차단) 아이가 재도전을 눌러도 서버가 문제를 만들지
	 * 못한다. 부모의 브라우저가 만들어 줘야 한다는 것을 아이 화면이 알아야 한다.
	 *
	 * 문항이 없는 회차를 "풀기 시작" 으로 보여주면 아이가 빈 판을 연다.
	 */
	it("서버가 못 만드는 제공자면 부모를 기다리고, 그동안 풀 수 없다", async () => {
		const { parent, child, attemptId, bookId } = await failedAttempt();
		await expireCooldown(attemptId);

		// 제공자만 Gemini 로 바꾼다. 인터셉터를 걸지 않았으므로 서버가 부르면 테스트가 실패한다.
		await env.DB.prepare("UPDATE parent_settings SET ai_provider = 'gemini'").run();

		const started = await child.client.post(`/api/attempts/${attemptId}/retry`);
		expect(started.status).toBe(201);
		expect(started.body.data.retry.status).toBe("NEEDS_PARENT");

		const nextAssignment = started.body.data.retry.nextAssignmentId;
		const inbox = (await child.client.get("/api/my/quizzes")).body.data.quizzes;
		const pending = inbox.find((q: { assignmentId: string }) => q.assignmentId === nextAssignment);
		expect(pending.ready).toBe(false);
		expect(pending.readyCount).toBe(0);

		// 빈 판은 열리지 않는다
		const blocked = await child.client.post("/api/attempts", { assignmentId: nextAssignment });
		expect(blocked.status).toBe(400);

		// 부모 화면에는 "문제 부족" 인 회차로 보인다
		const rounds = (await parent.get(`/api/books/${bookId}/quizzes`)).body.data.quizzes;
		expect(rounds[0].round).toBe(2);
		expect(rounds[0].generated).toBe(0);
		expect(rounds[0].questionCount).toBe(5);
	});

	it("남의 판으로는 재도전할 수 없다", async () => {
		const { attemptId } = await failedAttempt();
		const { client: other } = await signupParent();
		const stranger = await addChild(other, "남의아이");

		expect((await stranger.client.post(`/api/attempts/${attemptId}/retry`)).status).toBe(404);
	});
});
