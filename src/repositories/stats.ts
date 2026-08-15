import type { AppEnv } from "../types";

/**
 * 대시보드 집계(§19).
 *
 * 부모가 보고 싶은 것은 "우리 아이가 책을 읽고 있는가" 한 가지다. 점수를 줄 세우는 것이 아니라
 * **몇 권을 끝까지 읽었는지**가 중심이 되도록 센다.
 *
 * 모든 쿼리에 `quizzes.parent_user_id = ?` 를 넣어 남의 집계가 새지 않게 한다(§21.5).
 * 집계는 실시간으로 계산한다 — 이 규모(아이 몇 명 × 책 몇 권)에서 캐시는 이르다.
 */

export interface ChildStats {
	/** 시작한 판 수. 아직 푸는 중인 것도 포함한다. */
	attempts: number;
	/** 끝난 판 수. */
	completed: number;
	/** 통과한 판 수. */
	passed: number;
	/** 통과한 책 수. 같은 책을 여러 번 통과해도 하나로 센다 — 이게 "읽은 책" 이다. */
	booksPassed: number;
	/** 도전한 책 수. */
	booksTried: number;
	/** 2회차 이상으로 푼 판 수. 재도전한 만큼 다시 읽었다는 뜻이다. */
	retries: number;
	/** 끝난 판의 평균 점수. 끝난 판이 없으면 null. */
	averageScore: number | null;
	/** 마지막으로 푼 시각. */
	lastPlayedAt: string | null;
}

const EMPTY: ChildStats = {
	attempts: 0,
	completed: 0,
	passed: 0,
	booksPassed: 0,
	booksTried: 0,
	retries: 0,
	averageScore: null,
	lastPlayedAt: null,
};

/**
 * 아이별 집계를 한 번의 쿼리로 모은다.
 *
 * 아이마다 따로 물으면 아이 수만큼 왕복이 생긴다. D1 은 한 번의 왕복이 비싸다.
 */
export async function childStats(
	env: AppEnv,
	parentUserId: string,
	childIds: string[],
): Promise<Map<string, ChildStats>> {
	if (childIds.length === 0) return new Map();

	const placeholders = childIds.map(() => "?").join(",");
	const { results } = await env.DB.prepare(
		`SELECT t.child_id,
		        COUNT(*)                                                   AS attempts,
		        SUM(CASE WHEN t.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed,
		        SUM(t.passed)                                              AS passed,
		        COUNT(DISTINCT CASE WHEN t.passed = 1 THEN z.book_id END)  AS books_passed,
		        COUNT(DISTINCT z.book_id)                                  AS books_tried,
		        SUM(CASE WHEN z.round > 1 THEN 1 ELSE 0 END)               AS retries,
		        AVG(CASE WHEN t.completed_at IS NOT NULL THEN t.score END) AS average_score,
		        MAX(t.created_at)                                          AS last_played_at
		   FROM quiz_attempts t
		   JOIN quizzes z ON z.id = t.quiz_id
		  WHERE z.parent_user_id = ? AND t.child_id IN (${placeholders})
		  GROUP BY t.child_id`,
	)
		.bind(parentUserId, ...childIds)
		.all<{
			child_id: string;
			attempts: number;
			completed: number;
			passed: number;
			books_passed: number;
			books_tried: number;
			retries: number;
			average_score: number | null;
			last_played_at: string | null;
		}>();

	const stats = new Map<string, ChildStats>(childIds.map((id) => [id, { ...EMPTY }]));

	for (const row of results) {
		stats.set(row.child_id, {
			attempts: row.attempts,
			completed: row.completed,
			passed: row.passed ?? 0,
			booksPassed: row.books_passed,
			booksTried: row.books_tried,
			retries: row.retries ?? 0,
			// 평균은 소수점이 의미 없다. 아이에게 보여줄 숫자가 아니라 부모의 눈대중용이다.
			averageScore: row.average_score === null ? null : Math.round(row.average_score),
			lastPlayedAt: row.last_played_at,
		});
	}

	return stats;
}

export interface AttemptRecord {
	id: string;
	child_id: string;
	child_name: string;
	book_id: string;
	book_title: string;
	quiz_round: number;
	question_count: number;
	pass_count: number;
	correct_count: number;
	score: number;
	passed: number;
	started_at: string;
	completed_at: string | null;
}

const ATTEMPT_COLUMNS = `t.id, t.child_id, c.name AS child_name,
	        z.book_id, b.title AS book_title, z.round AS quiz_round,
	        z.question_count, z.pass_count,
	        t.correct_count, t.score, t.passed, t.started_at, t.completed_at`;

/** 이 부모의 모든 아이가 최근에 푼 판. 대시보드의 "최근 독서 퀴즈". */
export async function recentAttempts(
	env: AppEnv,
	parentUserId: string,
	limit = 10,
): Promise<AttemptRecord[]> {
	const { results } = await env.DB.prepare(
		`SELECT ${ATTEMPT_COLUMNS}
		   FROM quiz_attempts t
		   JOIN quizzes  z ON z.id = t.quiz_id
		   JOIN books    b ON b.id = z.book_id
		   JOIN children c ON c.id = t.child_id
		  WHERE z.parent_user_id = ?
		  ORDER BY t.created_at DESC
		  LIMIT ?`,
	)
		.bind(parentUserId, limit)
		.all<AttemptRecord>();

	return results;
}

/** 한 아이가 푼 판 전부. 아이 상세 화면이 쓴다. */
export async function attemptsByChild(
	env: AppEnv,
	parentUserId: string,
	childId: string,
	limit = 100,
): Promise<AttemptRecord[]> {
	const { results } = await env.DB.prepare(
		`SELECT ${ATTEMPT_COLUMNS}
		   FROM quiz_attempts t
		   JOIN quizzes  z ON z.id = t.quiz_id
		   JOIN books    b ON b.id = z.book_id
		   JOIN children c ON c.id = t.child_id
		  WHERE z.parent_user_id = ? AND t.child_id = ?
		  ORDER BY t.created_at DESC
		  LIMIT ?`,
	)
		.bind(parentUserId, childId, limit)
		.all<AttemptRecord>();

	return results;
}

/** 한 책에 대한 도전 기록 전부. 책 화면이 쓴다. */
export async function attemptsByBook(
	env: AppEnv,
	parentUserId: string,
	bookId: string,
): Promise<AttemptRecord[]> {
	const { results } = await env.DB.prepare(
		`SELECT ${ATTEMPT_COLUMNS}
		   FROM quiz_attempts t
		   JOIN quizzes  z ON z.id = t.quiz_id
		   JOIN books    b ON b.id = z.book_id
		   JOIN children c ON c.id = t.child_id
		  WHERE z.parent_user_id = ? AND z.book_id = ?
		  ORDER BY t.created_at DESC`,
	)
		.bind(parentUserId, bookId)
		.all<AttemptRecord>();

	return results;
}
