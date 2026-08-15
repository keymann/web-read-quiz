import { requireParent } from "../auth/guards";
import * as childrenRepo from "../repositories/children";
import * as historyRepo from "../repositories/history";
import type { HistoryFilter } from "../repositories/history";
import { ok } from "../utils/response";
import { route, type Route, type RouteCtx } from "./router";

/**
 * 문제·답 이력(§12·§16).
 *
 * 부모 설정의 "이력" 탭이 쓴다. AI 가 무엇을 만들었고 부모가 무엇을 고쳤는지,
 * 아이가 무엇을 어떻게 답했는지를 시간순으로 되짚을 수 있어야 한다.
 */

const MAX_LIMIT = 100;

function readFilter(url: URL): HistoryFilter & { childId?: string } {
	const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? "30") || 30));
	const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);

	const bookId = url.searchParams.get("bookId") ?? undefined;
	const quizId = url.searchParams.get("quizId") ?? undefined;
	const childId = url.searchParams.get("childId") ?? undefined;

	return { limit, offset, ...(bookId ? { bookId } : {}), ...(quizId ? { quizId } : {}), ...(childId ? { childId } : {}) };
}

/** JSON 으로 저장된 변경 전/후 스냅샷에서 화면에 쓸 만한 것만 꺼낸다. */
function summarize(raw: string | null): { questionText?: string; correctChoice?: number } | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as { questionText?: string; correctChoice?: number };
		return { questionText: parsed.questionText, correctChoice: parsed.correctChoice };
	} catch {
		return null;
	}
}

async function questions({ env, url, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	const filter = readFilter(url);
	const rows = await historyRepo.listQuestionHistory(env, parent.userId, filter);

	return ok({
		entries: rows.map((row) => ({
			id: row.id,
			createdAt: row.created_at,
			action: row.action,
			actorType: row.actor_type,
			questionNumber: row.question_number,
			questionText: row.question_text,
			bookTitle: row.book_title,
			quizId: row.quiz_id,
			quizRound: row.quiz_round,
			before: summarize(row.old_data),
			after: summarize(row.new_data),
		})),
		hasMore: rows.length === filter.limit,
	});
}

async function answers({ env, url, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	const filter = readFilter(url);
	const rows = await historyRepo.listAnswerHistory(env, parent.userId, filter);

	return ok({
		entries: rows.map((row) => ({
			id: row.id,
			answeredAt: row.answered_at,
			childName: row.child_name,
			bookTitle: row.book_title,
			quizRound: row.quiz_round,
			attemptId: row.attempt_id,
			questionNumber: row.question_number,
			// 아이가 실제로 본 문항. 이후 부모가 문제를 고쳐도 이 값은 변하지 않는다(§22).
			questionText: row.shown_text,
			selectedChoice: row.selected_choice,
			correctChoice: row.correct_choice,
			isCorrect: row.is_correct === 1,
		})),
		hasMore: rows.length === filter.limit,
	});
}

/** 이력 화면의 필터 선택지. */
async function filters({ env, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	const [books, children] = await Promise.all([
		historyRepo.listBooksWithHistory(env, parent.userId),
		childrenRepo.listByParent(env, parent.userId),
	]);

	return ok({
		books,
		children: children.map((c) => ({ id: c.id, name: c.name })),
	});
}

export const historyRoutes: Route[] = [
	route("GET", "/api/history/questions", questions),
	route("GET", "/api/history/answers", answers),
	route("GET", "/api/history/filters", filters),
];
