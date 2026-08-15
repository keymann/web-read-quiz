import { requireChild, requireParent } from "../auth/guards";
import * as v from "../utils/validate";
import * as assignmentsRepo from "../repositories/assignments";
import * as booksRepo from "../repositories/books";
import * as questionsRepo from "../repositories/questions";
import type { QuestionRow } from "../repositories/questions";
import * as quizzesRepo from "../repositories/quizzes";
import * as assignment from "../services/assignment";
import * as generation from "../services/generation";
import { conflict, invalid, notFound, ok } from "../utils/response";
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
	// 이 판만 다른 언어로 낼 수 있다. 안 보내면 부모 설정의 기본 언어.
	const language = v.optionalStr(body, "language");

	const quiz = await generation.createQuiz(
		env,
		parent.userId,
		bookId,
		language === undefined ? undefined : (language as never),
	);

	return ok(
		{ quiz: { id: quiz.id, status: quiz.status, round: quiz.round, language: quiz.language } },
		201,
	);
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
			language: quiz.language,
			error: quiz.generation_error,
			createdAt: quiz.created_at,
		},
		questions: questions.map(toQuestionView),
		progress: {
			generated: questions.length,
			total: quiz.question_count,
		},
		// 이미 나간 아이가 있으면 검수 화면이 그 사실을 보여준다.
		assignments: await assignment.listForQuiz(env, parent.userId, quiz.id),
	});
}

/**
 * 마음에 안 드는 문항만 골라 치운다(§21.7).
 *
 * 지우기만 하고 새로 만들지는 않는다. 비운 자리는 이어지는 생성이 채우는데, 그 경로가
 * 서버(백그라운드)와 브라우저 릴레이로 갈라져 있어 여기서 시작해 버리면 릴레이 쪽은
 * 홍콩 콜로에서 나가 막힌다. 화면이 이 응답을 받고 자기에게 맞는 경로로 생성을 잇는다.
 */
async function regenerate({ request, env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);

	const quiz = await quizzesRepo.findOwned(env, parent.userId, params.id!);
	if (!quiz) throw notFound("퀴즈를 찾을 수 없습니다.");
	if (!["DRAFT", "REVIEW"].includes(quiz.status)) {
		throw conflict("이미 제출했거나 진행 중인 퀴즈는 고칠 수 없습니다.");
	}

	const body = await v.readJson(request);
	const ids = Array.isArray(body.questionIds) ? (body.questionIds as unknown[]).map(String) : [];
	if (ids.length === 0) throw invalid("다시 만들 문제를 선택해 주세요.");

	const removed = await questionsRepo.deactivate(env, quiz.id, ids);
	if (removed === 0) throw notFound("선택한 문제를 찾을 수 없습니다.");

	const remaining = await questionsRepo.countActive(env, quiz.id);
	return ok({
		removed,
		remaining,
		need: quiz.question_count - remaining,
		total: quiz.question_count,
	});
}

/** 검수를 마친 퀴즈를 아이에게 내보낸다(§13). */
async function assignToChild({ request, env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);

	const body = await v.readJson(request);
	const childId = v.str(body, "childId", "아이");

	return ok({ assignment: await assignment.assign(env, parent.userId, params.id!, childId) }, 201);
}

/** 아이가 받은 퀴즈 목록. 푸는 화면은 다음 단계에서 붙는다. */
async function inbox({ env, principal }: RouteCtx): Promise<Response> {
	const child = requireChild(principal);
	const rows = await assignmentsRepo.listForChild(env, child.childId);

	return ok({
		quizzes: rows.map((row) => ({
			assignmentId: row.id,
			quizId: row.quiz_id,
			bookTitle: row.book_title,
			questionCount: row.question_count,
			passCount: row.pass_count,
			status: row.status,
			// 재도전은 배정을 먼저 만들고 문제를 나중에 만든다. 다 차기 전에는 풀 수 없다.
			ready: row.ready_count >= row.question_count,
			readyCount: row.ready_count,
			assignedAt: row.assigned_at,
		})),
	});
}

async function listForBook({ env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	const rows = await quizzesRepo.listByBook(env, parent.userId, params.id!);

	// 회차마다 문항이 몇 개 준비됐는지 함께 센다. 재도전은 문제 없이 배정만 먼저 생기므로,
	// 부모가 "만들어 줘야 할 회차" 를 알아볼 수 있어야 한다.
	const counts = await Promise.all(rows.map((q) => questionsRepo.countActive(env, q.id)));

	return ok({
		quizzes: rows.map((q, index) => ({
			id: q.id,
			status: q.status,
			round: q.round,
			language: q.language,
			questionCount: q.question_count,
			generated: counts[index]!,
			createdAt: q.created_at,
		})),
	});
}

export const quizRoutes: Route[] = [
	route("POST", "/api/quizzes", create),
	route("GET", "/api/quizzes/:id", detail),
	route("POST", "/api/quizzes/:id/generate", generate),
	route("POST", "/api/quizzes/:id/regenerate", regenerate),
	route("POST", "/api/quizzes/:id/assign", assignToChild),
	route("GET", "/api/books/:id/quizzes", listForBook),
	route("GET", "/api/my/quizzes", inbox),
];
