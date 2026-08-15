import * as booksRepo from "../repositories/books";
import * as childrenRepo from "../repositories/children";
import * as statsRepo from "../repositories/stats";
import type { AppEnv } from "../types";
import { notFound } from "../utils/response";

/**
 * 대시보드(§19).
 *
 * 부모가 보고 싶은 것은 "우리 아이가 책을 읽고 있는가" 한 가지다. 그래서 첫 줄에 오는 숫자는
 * 점수가 아니라 **끝까지 읽은 책 수**다. 점수는 그 아래에 눈대중용으로만 둔다.
 */

export interface AttemptView {
	id: string;
	childId: string;
	childName: string;
	bookId: string;
	bookTitle: string;
	round: number;
	total: number;
	passCount: number;
	correctCount: number;
	score: number;
	passed: boolean;
	startedAt: string;
	completedAt: string | null;
}

const toAttemptView = (row: statsRepo.AttemptRecord): AttemptView => ({
	id: row.id,
	childId: row.child_id,
	childName: row.child_name,
	bookId: row.book_id,
	bookTitle: row.book_title,
	round: row.quiz_round,
	total: row.question_count,
	passCount: row.pass_count,
	correctCount: row.correct_count,
	score: row.score,
	passed: row.passed === 1,
	startedAt: row.started_at,
	completedAt: row.completed_at,
});

export interface DashboardChild {
	id: string;
	name: string;
	grade: number | null;
	stats: statsRepo.ChildStats;
}

export interface Dashboard {
	children: DashboardChild[];
	recent: AttemptView[];
	/** 아이 전체를 합친 값. 아이가 하나뿐이어도 같은 숫자를 두 번 보여주지 않으려고 화면이 고른다. */
	totals: { booksPassed: number; attempts: number; passed: number };
}

export async function dashboard(env: AppEnv, userId: string): Promise<Dashboard> {
	const children = await childrenRepo.listByParent(env, userId);
	const stats = await statsRepo.childStats(
		env,
		userId,
		children.map((c) => c.id),
	);
	const recent = await statsRepo.recentAttempts(env, userId);

	const rows: DashboardChild[] = children.map((child) => ({
		id: child.id,
		name: child.name,
		grade: child.grade,
		stats: stats.get(child.id)!,
	}));

	return {
		children: rows,
		recent: recent.map(toAttemptView),
		totals: {
			booksPassed: rows.reduce((sum, c) => sum + c.stats.booksPassed, 0),
			attempts: rows.reduce((sum, c) => sum + c.stats.attempts, 0),
			passed: rows.reduce((sum, c) => sum + c.stats.passed, 0),
		},
	};
}

export interface BookProgress {
	bookId: string;
	bookTitle: string;
	/** 이 책에 몇 번 도전했는지. */
	attempts: number;
	/** 통과했는지. 한 번이라도 통과하면 읽은 것으로 본다. */
	passed: boolean;
	/** 가장 잘 본 점수. */
	bestScore: number;
	lastPlayedAt: string;
}

export interface ChildSummary {
	child: { id: string; name: string; grade: number | null };
	stats: statsRepo.ChildStats;
	/** 책별 진행. 최근에 도전한 책이 먼저. */
	books: BookProgress[];
	attempts: AttemptView[];
}

/**
 * 아이 한 명의 상세.
 *
 * 책별 요약은 판 목록에서 접어 만든다. 따로 쿼리를 짜면 같은 값을 두 곳에서 계산하게 되고,
 * 한쪽만 고쳤을 때 화면의 두 숫자가 어긋난다.
 */
export async function childSummary(
	env: AppEnv,
	userId: string,
	childId: string,
): Promise<ChildSummary> {
	const child = await childrenRepo.findOwned(env, userId, childId);
	if (!child) throw notFound("아이를 찾을 수 없습니다.");

	const rows = await statsRepo.attemptsByChild(env, userId, childId);
	const stats = (await statsRepo.childStats(env, userId, [childId])).get(childId)!;

	const byBook = new Map<string, BookProgress>();
	for (const row of rows) {
		const found = byBook.get(row.book_id);
		if (found) {
			found.attempts += 1;
			found.passed ||= row.passed === 1;
			found.bestScore = Math.max(found.bestScore, row.score);
			continue;
		}
		// 목록이 최신순이라 처음 만나는 판이 그 책의 마지막 도전이다.
		byBook.set(row.book_id, {
			bookId: row.book_id,
			bookTitle: row.book_title,
			attempts: 1,
			passed: row.passed === 1,
			bestScore: row.score,
			lastPlayedAt: row.started_at,
		});
	}

	return {
		child: { id: child.id, name: child.name, grade: child.grade },
		stats,
		books: [...byBook.values()],
		attempts: rows.map(toAttemptView),
	};
}

/** 한 책에 누가 몇 번 도전했는지. 책 화면이 쓴다. */
export async function bookHistory(
	env: AppEnv,
	userId: string,
	bookId: string,
): Promise<AttemptView[]> {
	const book = await booksRepo.findOwned(env, userId, bookId);
	if (!book) throw notFound("책을 찾을 수 없습니다.");

	return (await statsRepo.attemptsByBook(env, userId, bookId)).map(toAttemptView);
}
