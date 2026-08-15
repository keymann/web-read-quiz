import { fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { addChild, signupParent, type Client } from "./helpers";

/**
 * 아이에게 내주기(§13)와 일부 문항만 다시 만들기(§21.7).
 *
 * 두 기능이 한 파일에 있는 이유: 둘 다 "다 만든 퀴즈를 부모가 어떻게 처리하는가" 의 뒷단이고,
 * 같은 준비(키 등록 → 책 → 조사 → 20문항 생성)를 필요로 한다.
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

// 어휘가 겹치면 중복 검사(자카드 0.7)에 걸린다. 문항마다 어절 자체를 바꾼다.
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

/** 키 등록 → 책 → 조사 → 문항 5개 생성까지 끝난 퀴즈. */
async function quizWithQuestions(): Promise<{ client: Client; quizId: string }> {
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

	// 20문항은 이 테스트에 필요 없다. 5개로 줄여 생성을 가볍게 한다.
	await client.request("/api/settings/quiz", {
		method: "PUT",
		body: { questionCount: 5, passCount: 3 },
	});

	const form = new FormData();
	form.append("cover", new File([PNG], "cover.png", { type: "image/png" }));
	const bookId = (await client.upload("/api/books", form)).body.data.book.id as string;
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
		plotSummary: "잎싹이 양계장을 나와 초록머리를 기른다.",
		characters: [{ name: "잎싹", role: "암탉" }],
		keyEvents: ["양계장을 떠난다", "알을 품는다"],
		sources: [
			{ url: "https://example.com/a", title: "소개", content: "잎싹" },
			{ url: "https://example.com/b", title: "서평", content: "성장" },
		],
	});
	await client.post(`/api/books/${bookId}/search`);

	const quizId = (await client.post("/api/quizzes", { bookId })).body.data.quiz.id as string;

	const questions = makeQuestions(5);
	mockResponses({ questions });
	mockResponses(verdictsFor(questions));
	await generateAndWait(client, quizId);

	return { client, quizId };
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

describe("일부 문항만 다시 만들기", { timeout: 30_000 }, () => {
	it("고른 문항만 사라지고 그 자리가 다시 채워진다", async () => {
		const { client, quizId } = await quizWithQuestions();

		const before = (await client.get(`/api/quizzes/${quizId}`)).body.data.questions;
		expect(before).toHaveLength(5);
		const victims = [before[1], before[3]];

		const removed = await client.post(`/api/quizzes/${quizId}/regenerate`, {
			questionIds: victims.map((q: { id: string }) => q.id),
		});

		expect(removed.status).toBe(200);
		expect(removed.body.data.removed).toBe(2);
		expect(removed.body.data.need).toBe(2);

		// 지우기만 하고 새로 만들지는 않는다. 채우는 것은 화면이 잇는다.
		const between = (await client.get(`/api/quizzes/${quizId}`)).body.data.questions;
		expect(between).toHaveLength(3);
		expect(between.map((q: { id: string }) => q.id)).not.toContain(victims[0].id);

		// 남은 문항과 겹치지 않는 새 문항 2개
		const fresh = makeQuestions(2, 90);
		mockResponses({ questions: fresh });
		mockResponses(verdictsFor(fresh));
		const after = (await generateAndWait(client, quizId)).body.data.questions;

		expect(after).toHaveLength(5);
		// 남긴 문항은 그대로다. 통째로 다시 만들면 이것이 깨진다.
		const kept = before.filter((q: { id: string }) => !victims.some((v) => v.id === q.id));
		for (const q of kept) {
			expect(after.map((a: { id: string }) => a.id)).toContain(q.id);
		}
	});

	// 번호는 활성 문항 안에서 유일해야 한다. 이어 붙이기로 매기면 빈 자리를 채울 때 부딪힌다.
	it("비운 번호를 다시 쓴다", async () => {
		const { client, quizId } = await quizWithQuestions();

		const before = (await client.get(`/api/quizzes/${quizId}`)).body.data.questions;
		const second = before.find((q: { questionNumber: number }) => q.questionNumber === 2);

		await client.post(`/api/quizzes/${quizId}/regenerate`, { questionIds: [second.id] });

		const fresh = makeQuestions(1, 90);
		mockResponses({ questions: fresh });
		mockResponses(verdictsFor(fresh));
		const after = (await generateAndWait(client, quizId)).body.data.questions;

		const numbers = after.map((q: { questionNumber: number }) => q.questionNumber).sort();
		expect(numbers).toEqual([1, 2, 3, 4, 5]);
	});

	it("남의 퀴즈 문항 id 를 섞어 보내도 그 문항은 건드리지 않는다", async () => {
		const { client, quizId } = await quizWithQuestions();
		const { client: other, quizId: otherQuiz } = await quizWithQuestions();

		const mine = (await client.get(`/api/quizzes/${quizId}`)).body.data.questions[0];
		const theirs = (await other.get(`/api/quizzes/${otherQuiz}`)).body.data.questions[0];

		const res = await client.post(`/api/quizzes/${quizId}/regenerate`, {
			questionIds: [mine.id, theirs.id],
		});

		expect(res.body.data.removed).toBe(1);
		expect((await other.get(`/api/quizzes/${otherQuiz}`)).body.data.questions).toHaveLength(5);
	});

	it("선택이 비어 있으면 거부한다", async () => {
		const { client, quizId } = await quizWithQuestions();
		const res = await client.post(`/api/quizzes/${quizId}/regenerate`, { questionIds: [] });
		expect(res.status).toBe(400);
	});
});

/**
 * 문제 언어(§17). 책이 한국어여도 문제는 영어로 낼 수 있다.
 *
 * 프롬프트에 지시가 실렸는지까지만 본다. 실제로 영어로 나오는지는 모델의 몫이고
 * 검수 단계가 언어가 섞인 문항을 탈락시킨다.
 */
describe("문제 언어", { timeout: 30_000 }, () => {
	it("기본값은 영어다", async () => {
		const { client } = await signupParent();
		const view = await client.get("/api/settings");

		expect(view.body.data.quiz.questionLanguage).toBe("en");
		expect(view.body.data.quiz.languages.map((l: { value: string }) => l.value)).toEqual(["en", "ko"]);
	});

	it("설정을 바꾸면 이후 퀴즈가 그 언어로 만들어진다", async () => {
		const { client, quizId } = await quizWithQuestions();
		expect((await client.get(`/api/quizzes/${quizId}`)).body.data.quiz.language).toBe("en");

		await client.request("/api/settings/quiz", {
			method: "PUT",
			body: { questionCount: 5, passCount: 3, questionLanguage: "ko" },
		});

		const bookId = (await client.get(`/api/quizzes/${quizId}`)).body.data.quiz.bookId;
		const next = await client.post("/api/quizzes", { bookId });
		expect(next.body.data.quiz.language).toBe("ko");
	});

	// 이미 만든 퀴즈의 언어가 나중에 바뀌면, 부족한 문항을 채울 때 언어가 섞인다.
	it("설정을 바꿔도 이미 만든 퀴즈의 언어는 그대로다", async () => {
		const { client, quizId } = await quizWithQuestions();

		await client.request("/api/settings/quiz", {
			method: "PUT",
			body: { questionCount: 5, passCount: 3, questionLanguage: "ko" },
		});

		expect((await client.get(`/api/quizzes/${quizId}`)).body.data.quiz.language).toBe("en");
	});

	it("퀴즈를 만들 때 그 판만 다른 언어로 낼 수 있다", async () => {
		const { client, quizId } = await quizWithQuestions();
		const bookId = (await client.get(`/api/quizzes/${quizId}`)).body.data.quiz.bookId;

		const next = await client.post("/api/quizzes", { bookId, language: "ko" });
		expect(next.body.data.quiz.language).toBe("ko");
		// 부모의 기본값은 건드리지 않는다
		expect((await client.get("/api/settings")).body.data.quiz.questionLanguage).toBe("en");
	});

	it("모르는 언어는 거부한다", async () => {
		const { client, quizId } = await quizWithQuestions();
		const bookId = (await client.get(`/api/quizzes/${quizId}`)).body.data.quiz.bookId;

		expect((await client.post("/api/quizzes", { bookId, language: "fr" })).status).toBe(400);
		expect(
			(
				await client.request("/api/settings/quiz", {
					method: "PUT",
					body: { questionCount: 5, passCount: 3, questionLanguage: "fr" },
				})
			).status,
		).toBe(400);
	});

	// 문항 수만 고치러 온 요청이 언어를 기본값으로 되돌리면 안 된다.
	it("언어를 안 보내면 지금 값을 유지한다", async () => {
		const { client } = await signupParent();
		await client.request("/api/settings/quiz", {
			method: "PUT",
			body: { questionCount: 5, passCount: 3, questionLanguage: "ko" },
		});

		await client.request("/api/settings/quiz", {
			method: "PUT",
			body: { questionCount: 10, passCount: 6 },
		});

		expect((await client.get("/api/settings")).body.data.quiz.questionLanguage).toBe("ko");
	});
});

describe("아이에게 내주기", { timeout: 30_000 }, () => {
	it("다 만든 퀴즈를 아이에게 내주면 아이 화면에 도착한다", async () => {
		const { client, quizId } = await quizWithQuestions();
		const child = await addChild(client, "성현");

		const assigned = await client.post(`/api/quizzes/${quizId}/assign`, { childId: child.childId });
		expect(assigned.status).toBe(201);
		expect(assigned.body.data.assignment.childName).toBe("성현");

		// 부모 화면에서 "누구에게 냈는지" 가 보인다
		const detail = await client.get(`/api/quizzes/${quizId}`);
		expect(detail.body.data.quiz.status).toBe("ASSIGNED");
		expect(detail.body.data.assignments).toHaveLength(1);

		// 아이 화면에 도착한다
		const inbox = await child.client.get("/api/my/quizzes");
		expect(inbox.status).toBe(200);
		expect(inbox.body.data.quizzes).toHaveLength(1);
		expect(inbox.body.data.quizzes[0].bookTitle).toBe("마당을 나온 암탉");
		expect(inbox.body.data.quizzes[0].passCount).toBe(3);
	});

	// 덜 만든 퀴즈가 나가면 아이가 중간에 멈춘다.
	it("문항이 부족하면 내줄 수 없다", async () => {
		const { client, quizId } = await quizWithQuestions();
		const child = await addChild(client, "성현");

		const questions = (await client.get(`/api/quizzes/${quizId}`)).body.data.questions;
		await client.post(`/api/quizzes/${quizId}/regenerate`, { questionIds: [questions[0].id] });

		const res = await client.post(`/api/quizzes/${quizId}/assign`, { childId: child.childId });
		expect(res.status).toBe(400);
		expect(res.body.error.message).toContain("1문제가 부족");
	});

	it("같은 아이에게 두 번 내주지 않는다", async () => {
		const { client, quizId } = await quizWithQuestions();
		const child = await addChild(client, "성현");

		await client.post(`/api/quizzes/${quizId}/assign`, { childId: child.childId });
		const again = await client.post(`/api/quizzes/${quizId}/assign`, { childId: child.childId });

		expect(again.status).toBe(409);
	});

	it("남의 아이에게는 내줄 수 없다", async () => {
		const { client, quizId } = await quizWithQuestions();
		const { client: other } = await signupParent();
		const stranger = await addChild(other, "남의아이");

		const res = await client.post(`/api/quizzes/${quizId}/assign`, { childId: stranger.childId });
		expect(res.status).toBe(404);
	});

	// 이미 나간 퀴즈를 고치면 아이가 푸는 도중에 문제가 바뀐다(§21.6).
	it("내준 뒤에는 문항을 다시 만들 수 없다", async () => {
		const { client, quizId } = await quizWithQuestions();
		const child = await addChild(client, "성현");
		const questions = (await client.get(`/api/quizzes/${quizId}`)).body.data.questions;

		await client.post(`/api/quizzes/${quizId}/assign`, { childId: child.childId });

		const res = await client.post(`/api/quizzes/${quizId}/regenerate`, {
			questionIds: [questions[0].id],
		});
		expect(res.status).toBe(409);
	});

	it("다른 부모의 아이는 남의 퀴즈를 받지 못한다", async () => {
		const { client, quizId } = await quizWithQuestions();
		const child = await addChild(client, "성현");
		await client.post(`/api/quizzes/${quizId}/assign`, { childId: child.childId });

		const { client: other } = await signupParent();
		const stranger = await addChild(other, "남의아이");

		expect((await stranger.client.get("/api/my/quizzes")).body.data.quizzes).toHaveLength(0);
	});

	it("부모 계정은 아이 받은함을 쓸 수 없다", async () => {
		const { client } = await signupParent();
		expect((await client.get("/api/my/quizzes")).status).toBe(403);
	});
});
