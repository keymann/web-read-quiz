import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { scoreOf } from "../src/services/attempt";
import { addChild, signupParent, type Client } from "./helpers";

/**
 * 아이가 퀴즈를 푸는 판(§15·§17·§22).
 *
 * 확인하는 것: 시작 시 문항 고정, 한 문제 한 번, 통과 시 조기 종료, 정답 노출 경계, 소유 검사.
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

/**
 * 아이에게 배정까지 끝난 상태.
 *
 * 5문제 중 3개를 맞히면 통과다 — 조기 종료를 4번째 문항 전에 확인할 수 있는 최소 구성.
 */
async function assignedQuiz(): Promise<{
	parent: Client;
	child: Awaited<ReturnType<typeof addChild>>;
	assignmentId: string;
	quizId: string;
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

	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const detail = await parent.get(`/api/quizzes/${quizId}`);
		if (detail.body?.data?.quiz?.status !== "GENERATING") break;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	const child = await addChild(parent, "성현");
	const assigned = await parent.post(`/api/quizzes/${quizId}/assign`, { childId: child.childId });

	return { parent, child, assignmentId: assigned.body.data.assignment.assignmentId, quizId };
}

describe("점수 공식", () => {
	// §17 의 예시: 20문항 중 10개 통과 기준에서 10개 정답 → 100점, 8개 → 80점.
	it("통과 기준을 100점으로 환산한다", () => {
		expect(scoreOf(10, 10)).toBe(100);
		expect(scoreOf(8, 10)).toBe(80);
		expect(scoreOf(0, 10)).toBe(0);
		// 기준을 넘겨도 100점을 넘지 않는다
		expect(scoreOf(12, 10)).toBe(100);
		// 부모가 문항 수를 바꿔도 같은 의미다
		expect(scoreOf(3, 3)).toBe(100);
		expect(scoreOf(2, 3)).toBe(67);
	});
});

describe("퀴즈 풀기", { timeout: 30_000 }, () => {
	it("시작하면 문항이 고정되고 진행 상태가 따라온다", async () => {
		const { child, assignmentId } = await assignedQuiz();

		const started = await child.client.post("/api/attempts", { assignmentId });
		expect(started.status).toBe(201);

		const attempt = started.body.data.attempt;
		expect(attempt.questions).toHaveLength(5);
		expect(attempt.total).toBe(5);
		expect(attempt.passCount).toBe(3);
		expect(attempt.answered).toBe(0);
		expect(attempt.nextNumber).toBe(1);
		expect(attempt.completedAt).toBeNull();
	});

	// 정답이 응답에 담기기만 해도 개발자 도구로 볼 수 있다.
	it("아직 안 푼 문항에는 정답이 실리지 않는다", async () => {
		const { child, assignmentId } = await assignedQuiz();
		const { attempt } = (await child.client.post("/api/attempts", { assignmentId })).body.data;

		for (const q of attempt.questions) {
			expect(q.choices).toHaveLength(4);
			expect(q.correctChoice).toBeNull();
			expect(q.explanation).toBeNull();
			expect(q.isCorrect).toBeNull();
		}
	});

	it("답하면 즉시 채점되고 그 문항에만 정답이 열린다", async () => {
		const { parent, child, assignmentId, quizId } = await assignedQuiz();
		const answers = (await parent.get(`/api/quizzes/${quizId}`)).body.data.questions;
		const { attempt } = (await child.client.post("/api/attempts", { assignmentId })).body.data;

		const first = answers.find((q: { questionNumber: number }) => q.questionNumber === 1);
		const res = await child.client.post(`/api/attempts/${attempt.id}/answers`, {
			questionNumber: 1,
			selectedChoice: first.correctChoice,
		});

		expect(res.status).toBe(200);
		expect(res.body.data.isCorrect).toBe(true);
		expect(res.body.data.explanation).toBeTruthy();

		const questions = res.body.data.attempt.questions;
		expect(questions[0].correctChoice).toBe(first.correctChoice);
		// 나머지는 여전히 닫혀 있다
		expect(questions[1].correctChoice).toBeNull();
	});

	// §15. 되돌아가 볼 수는 있어도 다시 답할 수는 없다.
	it("같은 문제에 두 번 답할 수 없다", async () => {
		const { parent, child, assignmentId, quizId } = await assignedQuiz();
		const answers = (await parent.get(`/api/quizzes/${quizId}`)).body.data.questions;
		const { attempt } = (await child.client.post("/api/attempts", { assignmentId })).body.data;

		const wrong = (answers[0].correctChoice % 4) + 1;
		await child.client.post(`/api/attempts/${attempt.id}/answers`, {
			questionNumber: 1,
			selectedChoice: wrong,
		});
		const again = await child.client.post(`/api/attempts/${attempt.id}/answers`, {
			questionNumber: 1,
			selectedChoice: answers[0].correctChoice,
		});

		expect(again.status).toBe(409);

		// 오답이 정답으로 뒤집히지 않았다
		const view = (await child.client.get(`/api/attempts/${attempt.id}`)).body.data.attempt;
		expect(view.questions[0].isCorrect).toBe(false);
		expect(view.correctCount).toBe(0);
		expect(view.wrongCount).toBe(1);
	});

	// §15 조기 종료. 통과 기준을 채운 그 자리에서 끝난다.
	it("통과 기준을 채우면 남은 문항을 두고 끝난다", async () => {
		const { parent, child, assignmentId, quizId } = await assignedQuiz();
		const answers = (await parent.get(`/api/quizzes/${quizId}`)).body.data.questions;
		const { attempt } = (await child.client.post("/api/attempts", { assignmentId })).body.data;

		let last;
		for (const number of [1, 2, 3]) {
			const q = answers.find((a: { questionNumber: number }) => a.questionNumber === number);
			last = await child.client.post(`/api/attempts/${attempt.id}/answers`, {
				questionNumber: number,
				selectedChoice: q.correctChoice,
			});
		}

		expect(last!.body.data.finished).toBe(true);

		const view = (await child.client.get(`/api/attempts/${attempt.id}`)).body.data.attempt;
		expect(view.completedAt).not.toBeNull();
		expect(view.passed).toBe(true);
		expect(view.score).toBe(100);
		expect(view.correctCount).toBe(3);
		// 남은 두 문항은 미응답으로 남는다
		expect(view.questions.filter((q: { selectedChoice: number | null }) => q.selectedChoice === null)).toHaveLength(2);

		// 끝난 판에는 더 답할 수 없다
		const after = await child.client.post(`/api/attempts/${attempt.id}/answers`, {
			questionNumber: 4,
			selectedChoice: 1,
		});
		expect(after.status).toBe(409);
	});

	it("다 틀리면 마지막 문항에서 끝나고 통과하지 못한다", async () => {
		const { parent, child, assignmentId, quizId } = await assignedQuiz();
		const answers = (await parent.get(`/api/quizzes/${quizId}`)).body.data.questions;
		const { attempt } = (await child.client.post("/api/attempts", { assignmentId })).body.data;

		for (const q of answers) {
			await child.client.post(`/api/attempts/${attempt.id}/answers`, {
				questionNumber: q.questionNumber,
				selectedChoice: (q.correctChoice % 4) + 1,
			});
		}

		const view = (await child.client.get(`/api/attempts/${attempt.id}`)).body.data.attempt;
		expect(view.completedAt).not.toBeNull();
		expect(view.passed).toBe(false);
		expect(view.score).toBe(0);
	});

	it("그만 풀면 지금까지의 결과로 확정된다", async () => {
		const { parent, child, assignmentId, quizId } = await assignedQuiz();
		const answers = (await parent.get(`/api/quizzes/${quizId}`)).body.data.questions;
		const { attempt } = (await child.client.post("/api/attempts", { assignmentId })).body.data;

		await child.client.post(`/api/attempts/${attempt.id}/answers`, {
			questionNumber: 1,
			selectedChoice: answers[0].correctChoice,
		});

		const done = await child.client.post(`/api/attempts/${attempt.id}/submit`);
		expect(done.status).toBe(200);
		expect(done.body.data.attempt.completedAt).not.toBeNull();
		expect(done.body.data.attempt.passed).toBe(false);
		// 3개 중 1개 → 33점
		expect(done.body.data.attempt.score).toBe(33);
	});

	// 새로 시작하면 앞서 답한 것이 사라진 것처럼 보이고 이력에 두 판이 겹쳐 쌓인다.
	it("풀던 판이 있으면 새로 시작하지 않고 이어 준다", async () => {
		const { parent, child, assignmentId, quizId } = await assignedQuiz();
		const answers = (await parent.get(`/api/quizzes/${quizId}`)).body.data.questions;

		const first = (await child.client.post("/api/attempts", { assignmentId })).body.data.attempt;
		await child.client.post(`/api/attempts/${first.id}/answers`, {
			questionNumber: 1,
			selectedChoice: answers[0].correctChoice,
		});

		const again = (await child.client.post("/api/attempts", { assignmentId })).body.data.attempt;
		expect(again.id).toBe(first.id);
		expect(again.answered).toBe(1);
		expect(again.nextNumber).toBe(2);
	});

	// 이미 내준 퀴즈를 고치면 아이가 푸는 도중에 문제가 바뀐다(§21.6).
	it("아이가 풀기 시작하면 부모도 문항을 고칠 수 없다", async () => {
		const { parent, child, assignmentId, quizId } = await assignedQuiz();
		const answers = (await parent.get(`/api/quizzes/${quizId}`)).body.data.questions;
		await child.client.post("/api/attempts", { assignmentId });

		const res = await parent.post(`/api/quizzes/${quizId}/regenerate`, {
			questionIds: [answers[2].id],
		});
		expect(res.status).toBe(409);
	});

	/**
	 * 라우트가 막아 주더라도 판 자체가 버텨야 한다(§22).
	 *
	 * `questions` 를 직접 바꿔 놓고 확인한다 — 판이 `question_versions` 가 아니라 `questions`
	 * 를 읽고 있으면 여기서 드러난다.
	 */
	it("questions 가 바뀌어도 판은 시작 시점 본문을 그대로 보여준다", async () => {
		const { parent, child, assignmentId, quizId } = await assignedQuiz();
		const { attempt } = (await child.client.post("/api/attempts", { assignmentId })).body.data;
		const before = attempt.questions.map((q: { questionText: string }) => q.questionText);

		await env.DB.prepare("UPDATE questions SET question_text = ? WHERE quiz_id = ?")
			.bind("부모가 나중에 고친 문장", quizId)
			.run();

		const view = (await child.client.get(`/api/attempts/${attempt.id}`)).body.data.attempt;
		expect(view.questions.map((q: { questionText: string }) => q.questionText)).toEqual(before);

		// 부모 화면에는 바뀐 문장이 보인다 — 두 값이 실제로 갈라져 있다는 뜻이다
		const now = (await parent.get(`/api/quizzes/${quizId}`)).body.data.questions;
		expect(now[0].questionText).toBe("부모가 나중에 고친 문장");
	});
});

describe("퀴즈 풀이 권한", { timeout: 30_000 }, () => {
	it("남의 배정으로는 시작할 수 없다", async () => {
		const { assignmentId } = await assignedQuiz();
		const { client: other } = await signupParent();
		const stranger = await addChild(other, "남의아이");

		const res = await stranger.client.post("/api/attempts", { assignmentId });
		expect(res.status).toBe(403);
	});

	it("남의 판은 열리지도 답해지지도 않는다", async () => {
		const { child, assignmentId } = await assignedQuiz();
		const { attempt } = (await child.client.post("/api/attempts", { assignmentId })).body.data;

		const { client: other } = await signupParent();
		const stranger = await addChild(other, "남의아이");

		expect((await stranger.client.get(`/api/attempts/${attempt.id}`)).status).toBe(404);
		expect(
			(
				await stranger.client.post(`/api/attempts/${attempt.id}/answers`, {
					questionNumber: 1,
					selectedChoice: 1,
				})
			).status,
		).toBe(404);
	});

	it("부모 계정은 아이 경로를 쓸 수 없다", async () => {
		const { parent, assignmentId } = await assignedQuiz();

		expect((await parent.post("/api/attempts", { assignmentId })).status).toBe(403);
		expect((await parent.get("/api/my/attempts")).status).toBe(403);
	});

	it("1~4 밖의 답은 거부한다", async () => {
		const { child, assignmentId } = await assignedQuiz();
		const { attempt } = (await child.client.post("/api/attempts", { assignmentId })).body.data;

		for (const selectedChoice of [0, 5, -1]) {
			const res = await child.client.post(`/api/attempts/${attempt.id}/answers`, {
				questionNumber: 1,
				selectedChoice,
			});
			expect(res.status).toBe(400);
		}
	});
});

describe("풀이 이력", { timeout: 30_000 }, () => {
	it("아이는 자기 기록만, 부모는 답안 이력에서 본다", async () => {
		const { parent, child, assignmentId, quizId } = await assignedQuiz();
		const answers = (await parent.get(`/api/quizzes/${quizId}`)).body.data.questions;
		const { attempt } = (await child.client.post("/api/attempts", { assignmentId })).body.data;

		await child.client.post(`/api/attempts/${attempt.id}/answers`, {
			questionNumber: 1,
			selectedChoice: answers[0].correctChoice,
		});

		const mine = await child.client.get("/api/my/attempts");
		expect(mine.body.data.attempts).toHaveLength(1);
		expect(mine.body.data.attempts[0].bookTitle).toBe("마당을 나온 암탉");

		// 부모의 답안 이력에도 같은 답이 보이고, 선택지 본문까지 함께 온다
		const history = await parent.get("/api/history/answers");
		expect(history.body.data.entries).toHaveLength(1);
		const entry = history.body.data.entries[0];
		expect(entry.childName).toBe("성현");
		expect(entry.isCorrect).toBe(true);
		expect(entry.choices).toHaveLength(4);
		expect(entry.choices[entry.correctChoice - 1]).toBeTruthy();
	});

	// 부모가 검수할 때 정답을 함께 볼 수 있어야 한다.
	it("문제 이력에 선택지와 정답이 함께 온다", async () => {
		const { parent } = await assignedQuiz();

		const history = await parent.get("/api/history/questions");
		expect(history.body.data.entries.length).toBeGreaterThan(0);

		for (const entry of history.body.data.entries) {
			expect(entry.choices).toHaveLength(4);
			expect(entry.correctChoice).toBeGreaterThanOrEqual(1);
			expect(entry.correctChoice).toBeLessThanOrEqual(4);
		}
	});
});
