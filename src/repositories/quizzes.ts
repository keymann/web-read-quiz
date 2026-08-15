import type { AppEnv, QuestionLanguage, QuizStatus } from "../types";

/** `quizzes` 테이블 접근. 소유자(parent_user_id)를 항상 WHERE 에 넣는다(§21.5). */

export interface QuizRow {
	id: string;
	book_id: string;
	parent_user_id: string;
	status: QuizStatus;
	round: number;
	/** 이 퀴즈의 출제 문항 수. 설정을 나중에 바꿔도 이 값은 그대로다. */
	question_count: number;
	/** 이 퀴즈의 통과 기준(맞혀야 하는 문항 수). */
	pass_count: number;
	/** 이 퀴즈의 문제를 낸 언어. 부족한 문항을 채울 때도 이 값을 따른다. */
	language: QuestionLanguage;
	generation_error: string | null;
	created_at: string;
	updated_at: string;
}

export async function insert(
	env: AppEnv,
	quiz: {
		id: string;
		bookId: string;
		parentUserId: string;
		round: number;
		questionCount: number;
		passCount: number;
		language: QuestionLanguage;
	},
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO quizzes (id, book_id, parent_user_id, round, question_count, pass_count, language)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			quiz.id,
			quiz.bookId,
			quiz.parentUserId,
			quiz.round,
			quiz.questionCount,
			quiz.passCount,
			quiz.language,
		)
		.run();
}

/** 소유 확인 없이 읽는다. 아이 경로처럼 배정으로 소유가 이미 확인된 곳에서만 쓴다. */
export async function find(env: AppEnv, quizId: string): Promise<QuizRow | null> {
	return env.DB.prepare("SELECT * FROM quizzes WHERE id = ?").bind(quizId).first<QuizRow>();
}

export async function findOwned(
	env: AppEnv,
	parentUserId: string,
	quizId: string,
): Promise<QuizRow | null> {
	return env.DB.prepare("SELECT * FROM quizzes WHERE id = ? AND parent_user_id = ?")
		.bind(quizId, parentUserId)
		.first<QuizRow>();
}

export async function listByBook(
	env: AppEnv,
	parentUserId: string,
	bookId: string,
): Promise<QuizRow[]> {
	const { results } = await env.DB.prepare(
		"SELECT * FROM quizzes WHERE book_id = ? AND parent_user_id = ? ORDER BY round DESC",
	)
		.bind(bookId, parentUserId)
		.all<QuizRow>();
	return results;
}

/** 이 책의 다음 회차 번호(§18 재도전). */
export async function nextRound(env: AppEnv, bookId: string): Promise<number> {
	const row = await env.DB.prepare("SELECT MAX(round) AS m FROM quizzes WHERE book_id = ?")
		.bind(bookId)
		.first<{ m: number | null }>();
	return (row?.m ?? 0) + 1;
}

export async function setStatus(
	env: AppEnv,
	quizId: string,
	status: QuizStatus,
	generationError: string | null = null,
): Promise<void> {
	await env.DB.prepare(
		`UPDATE quizzes
		    SET status = ?, generation_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		  WHERE id = ?`,
	)
		.bind(status, generationError, quizId)
		.run();
}

/**
 * 이미 생성 중이면 다시 시작하지 않는다.
 * 상태 확인과 전이를 한 문장으로 처리해, 동시에 두 번 눌러도 하나만 통과하게 한다.
 */
export async function claimForGeneration(env: AppEnv, quizId: string): Promise<boolean> {
	const result = await env.DB.prepare(
		`UPDATE quizzes
		    SET status = 'GENERATING', generation_error = NULL,
		        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		  WHERE id = ? AND status IN ('DRAFT', 'REVIEW')`,
	)
		.bind(quizId)
		.run();

	return (result.meta.changes ?? 0) > 0;
}
