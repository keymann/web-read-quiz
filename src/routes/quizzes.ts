import { requireParent } from "../auth/guards";
import * as v from "../utils/validate";
import * as booksRepo from "../repositories/books";
import * as questionsRepo from "../repositories/questions";
import type { QuestionRow } from "../repositories/questions";
import * as quizzesRepo from "../repositories/quizzes";
import * as generation from "../services/generation";
import { conflict, notFound, ok } from "../utils/response";
import { rateLimit } from "../utils/ratelimit";
import { route, type Route, type RouteCtx } from "./router";

/** 부모에게 내보내는 문항. 검수 화면에서 정답·해설을 함께 본다(§11). */
const toQuestionView = (row: QuestionRow) => ({
	id: row.id,
	questionNumber: row.question_number,
	questionText: row.question_text,
	choices: [row.choice1, row.choice2, row.choice3, row.choice4],
	correctChoice: row.correct_choice,
	questionType: row.question_type,
	difficulty: row.difficulty,
	explanation: row.explanation,
	evidence: row.evidence,
	readRequired: row.read_required === 1,
	version: row.current_version,
});

async function create({ request, env, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	const body = await v.readJson(request);
	const bookId = v.str(body, "bookId", "책");

	const quiz = await generation.createQuiz(env, parent.userId, bookId);
	return ok({ quiz: { id: quiz.id, status: quiz.status, round: quiz.round } }, 201);
}

/**
 * 생성 시작. **202 를 즉시 돌려주고** 실제 작업은 백그라운드에서 돈다.
 * 20문항 생성과 검증은 수십 초가 걸려 요청을 붙잡고 있을 수 없다(§아키텍처).
 */
async function generate({ env, ctx, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	await rateLimit(env, "ai", parent.userId, 20, 60 * 60);

	const quiz = await quizzesRepo.findOwned(env, parent.userId, params.id!);
	if (!quiz) throw notFound("퀴즈를 찾을 수 없습니다.");

	// 이미 아이에게 나간 퀴즈는 건드리지 않는다(§21.6).
	if (!["DRAFT", "REVIEW"].includes(quiz.status)) {
		throw conflict("이미 제출했거나 진행 중인 퀴즈는 다시 생성할 수 없습니다.");
	}

	// 상태 확인과 전이를 한 문장으로 처리해 동시에 두 번 눌러도 하나만 통과하게 한다.
	if (!(await quizzesRepo.claimForGeneration(env, quiz.id))) {
		throw conflict("이미 문제를 만들고 있습니다.");
	}

	ctx.waitUntil(generation.runGeneration(env, parent.userId, quiz.id));

	return ok({ status: "GENERATING", total: quiz.question_count }, 202);
}

async function detail({ env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	const quiz = await quizzesRepo.findOwned(env, parent.userId, params.id!);
	if (!quiz) throw notFound("퀴즈를 찾을 수 없습니다.");

	const [book, questions] = await Promise.all([
		booksRepo.findOwned(env, parent.userId, quiz.book_id),
		questionsRepo.listActive(env, quiz.id),
	]);

	return ok({
		quiz: {
			id: quiz.id,
			bookId: quiz.book_id,
			bookTitle: book?.title ?? "",
			status: quiz.status,
			round: quiz.round,
			questionCount: quiz.question_count,
			passCount: quiz.pass_count,
			error: quiz.generation_error,
			createdAt: quiz.created_at,
		},
		questions: questions.map(toQuestionView),
		progress: {
			generated: questions.length,
			total: quiz.question_count,
		},
	});
}

async function listForBook({ env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	const rows = await quizzesRepo.listByBook(env, parent.userId, params.id!);

	return ok({
		quizzes: rows.map((q) => ({
			id: q.id,
			status: q.status,
			round: q.round,
			createdAt: q.created_at,
		})),
	});
}

export const quizRoutes: Route[] = [
	route("POST", "/api/quizzes", create),
	route("GET", "/api/quizzes/:id", detail),
	route("POST", "/api/quizzes/:id/generate", generate),
	route("GET", "/api/books/:id/quizzes", listForBook),
];
