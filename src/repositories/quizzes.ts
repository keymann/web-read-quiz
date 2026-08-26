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

/**
 * 이 회차와 거기서 나온 **모든 기록**을 지운다.
 *
 * 문항은 보통 감추는 데 그치지만(`is_active = 0`) 여기서는 행까지 지운다. 부모가 회차를
 * 지우는 것은 "다른 문제를 내 달라" 가 아니라 **"이 회차를 없애 달라"** 는 뜻이고, 그 회차에
 * 딸린 아이의 도전 기록도 함께 사라져야 한다. `books.remove` 와 같은 판단이다.
 *
 * 스키마에 `ON DELETE CASCADE` 가 있지만 자식부터 직접 지운다 — 외래키 강제 여부에 기대지
 * 않아도 되고, **무엇이 함께 사라지는지가 코드에 적혀 있어야** 부모에게 알릴 말을 한 곳에서
 * 정할 수 있다. 한 `batch` 로 보내므로 왕복은 한 번이고, 중간에 실패하면 전부 되돌아간다.
 */
export async function remove(env: AppEnv, parentUserId: string, quizId: string): Promise<boolean> {
	const questionIds = "SELECT id FROM questions WHERE quiz_id = ?";
	const attemptIds = "SELECT id FROM quiz_attempts WHERE quiz_id = ?";

	// 각 문장의 `?` 는 하나뿐이라 모두 같은 값을 바인딩한다.
	const cascade = [
		`DELETE FROM question_answers WHERE attempt_id IN (${attemptIds})`,
		`DELETE FROM attempt_questions WHERE attempt_id IN (${attemptIds})`,
		"DELETE FROM quiz_attempts WHERE quiz_id = ?",
		"DELETE FROM quiz_assignments WHERE quiz_id = ?",
		`DELETE FROM question_validations WHERE question_id IN (${questionIds})`,
		`DELETE FROM question_histories WHERE question_id IN (${questionIds})`,
		`DELETE FROM question_versions WHERE question_id IN (${questionIds})`,
		"DELETE FROM questions WHERE quiz_id = ?",
	];

	const results = await env.DB.batch([
		...cascade.map((sql) => env.DB.prepare(sql).bind(quizId)),
		// 소유 확인을 마지막 문장에도 넣는다. 남의 퀴즈가 지워지는 일은 어느 층에서도 막아야 한다.
		env.DB.prepare("DELETE FROM quizzes WHERE id = ? AND parent_user_id = ?").bind(quizId, parentUserId),
	]);

	// 마지막 문장이 퀴즈 행이다. 그것이 지워졌을 때만 삭제로 본다.
	return (results[results.length - 1]?.meta.changes ?? 0) > 0;
}

/**
 * 남은 회차에 **만든 순서대로 1번부터 다시 번호를 매긴다.**
 *
 * 회차를 지우면 번호에 구멍이 난다. "1회차 · 3회차" 는 부모에게 2회차를 어디서 잃었는지 묻게
 * 만들고, 다음 회차 번호(`nextRound` = 최댓값 + 1)도 그 구멍만큼 앞서 나간다.
 *
 * 같은 밀리초에 만든 회차가 있을 수 있다. 시각만으로 세면 그 둘이 같은 번호를 받으므로
 * `rowid` 를 함께 본다 — 넣은 순서가 그대로 담겨 있어 만든 순서와 어긋나지 않는다.
 */
export async function renumberRounds(env: AppEnv, bookId: string): Promise<void> {
	await env.DB.prepare(
		`UPDATE quizzes
		    SET round = (
		          SELECT COUNT(*) FROM quizzes AS earlier
		           WHERE earlier.book_id = quizzes.book_id
		             AND (earlier.created_at < quizzes.created_at
		                  OR (earlier.created_at = quizzes.created_at AND earlier.rowid <= quizzes.rowid))
		        ),
		        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		  WHERE book_id = ?`,
	)
		.bind(bookId)
		.run();
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
