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
	/** 지금 무엇을 하고 있는지. 화면이 그대로 문장으로 옮긴다. */
	generation_phase: string | null;
	/** 이번 생성이 시작된 시각. 경과 시간을 여기서부터 센다. */
	generation_started_at: string | null;
	/** 부모가 취소를 눌렀다는 표시. 루프가 단계마다 보고 스스로 멈춘다. */
	cancel_requested: number;
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
 *
 * 시작 시각과 단계를 여기서 함께 세운다. 지난 회차의 취소 표시도 지운다 — 안 지우면
 * 새 생성이 시작하자마자 취소된 것으로 보인다.
 */
export async function claimForGeneration(env: AppEnv, quizId: string): Promise<boolean> {
	const result = await env.DB.prepare(
		`UPDATE quizzes
		    SET status = 'GENERATING', generation_error = NULL,
		        generation_phase = 'planning',
		        generation_started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
		        cancel_requested = 0,
		        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		  WHERE id = ? AND status IN ('DRAFT', 'REVIEW')`,
	)
		.bind(quizId)
		.run();

	return (result.meta.changes ?? 0) > 0;
}

/**
 * 진행 단계를 적는다. 화면이 폴링으로 읽어 부모에게 보여준다.
 *
 * 라운드 번호나 문항 수 같은 곁가지는 `phase` 문자열에 담지 않는다 — 화면이 문장을
 * 만들고 여기는 단계 이름만 둔다. 그래야 문구를 고칠 때 서버를 건드리지 않는다.
 */
export async function setPhase(env: AppEnv, quizId: string, phase: string): Promise<void> {
	await env.DB.prepare(
		`UPDATE quizzes SET generation_phase = ? WHERE id = ? AND status = 'GENERATING'`,
	)
		.bind(phase, quizId)
		.run();
}

/**
 * 취소를 요청한다. 백그라운드 작업은 밖에서 죽일 수 없으므로 표시만 남기고,
 * 루프가 다음 단계로 넘어갈 때 스스로 멈춘다.
 *
 * 소유자 확인을 이 문장 안에서 한다 — 남의 퀴즈를 멈출 수 있으면 안 된다.
 */
export async function requestCancel(env: AppEnv, userId: string, quizId: string): Promise<boolean> {
	const result = await env.DB.prepare(
		`UPDATE quizzes
		    SET cancel_requested = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		  WHERE id = ? AND parent_user_id = ?`,
	)
		.bind(quizId, userId)
		.run();

	return (result.meta.changes ?? 0) > 0;
}

/** 취소가 걸렸는지. 루프가 단계마다 부른다. */
export async function isCancelled(env: AppEnv, quizId: string): Promise<boolean> {
	const row = await env.DB.prepare("SELECT cancel_requested FROM quizzes WHERE id = ?")
		.bind(quizId)
		.first<{ cancel_requested: number }>();

	return (row?.cancel_requested ?? 0) === 1;
}
