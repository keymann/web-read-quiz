import type { AppEnv } from "../types";
import { newId } from "../utils/id";

/**
 * `quiz_attempts` · `attempt_questions` · `question_answers` 접근(§15·§22).
 *
 * Attempt 를 시작할 때 출제된 문항을 **버전 단위로 고정한다.** 아이가 푸는 동안 부모가 문제를
 * 고치거나 지워도 이미 시작한 판은 그대로여야 하고, 나중에 이력을 볼 때도 "그때 본 문항"이
 * 재구성되어야 한다.
 */

export interface AttemptRow {
	id: string;
	assignment_id: string;
	quiz_id: string;
	child_id: string;
	attempt_no: number;
	started_at: string;
	completed_at: string | null;
	correct_count: number;
	wrong_count: number;
	score: number;
	passed: number;
	created_at: string;
}

/** Attempt 에 고정된 문항 한 개. 본문은 버전에서 온다 — `questions` 를 읽지 않는다. */
export interface AttemptQuestionRow {
	question_id: string;
	question_version_id: string;
	question_number: number;
	question_text: string;
	choice1: string;
	choice2: string;
	choice3: string;
	choice4: string;
	correct_choice: number;
	explanation: string | null;
	evidence: string | null;
	/** 이미 답했으면 그 값. 아직이면 null. */
	selected_choice: number | null;
	is_correct: number | null;
}

export async function findOwned(
	env: AppEnv,
	childId: string,
	attemptId: string,
): Promise<AttemptRow | null> {
	return env.DB.prepare("SELECT * FROM quiz_attempts WHERE id = ? AND child_id = ?")
		.bind(attemptId, childId)
		.first<AttemptRow>();
}

/** 이 배정에서 아직 안 끝난 판. 새로 시작하지 않고 이어서 풀게 한다. */
export async function findOpenForAssignment(
	env: AppEnv,
	assignmentId: string,
): Promise<AttemptRow | null> {
	return env.DB.prepare(
		"SELECT * FROM quiz_attempts WHERE assignment_id = ? AND completed_at IS NULL",
	)
		.bind(assignmentId)
		.first<AttemptRow>();
}

export async function countForAssignment(env: AppEnv, assignmentId: string): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) AS c FROM quiz_attempts WHERE assignment_id = ?",
	)
		.bind(assignmentId)
		.first<{ c: number }>();
	return row?.c ?? 0;
}

export interface NewAttempt {
	assignmentId: string;
	quizId: string;
	childId: string;
	attemptNo: number;
	/** 고정할 문항. `questions` 의 활성 문항과 그 현재 버전. */
	questions: { questionId: string; versionId: string; questionNumber: number }[];
}

/**
 * Attempt 를 만들고 문항을 고정한다.
 *
 * 배정 상태 전이까지 같은 배치에 넣는다. 문항만 고정되고 배정이 ASSIGNED 로 남으면
 * 아이 화면이 "새 퀴즈" 라고 계속 보여준다.
 */
export async function start(env: AppEnv, attempt: NewAttempt): Promise<string> {
	const attemptId = newId();

	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO quiz_attempts (id, assignment_id, quiz_id, child_id, attempt_no)
			 VALUES (?, ?, ?, ?, ?)`,
		).bind(attemptId, attempt.assignmentId, attempt.quizId, attempt.childId, attempt.attemptNo),

		...attempt.questions.map((q) =>
			env.DB.prepare(
				`INSERT INTO attempt_questions (id, attempt_id, question_id, question_version_id, question_number)
				 VALUES (?, ?, ?, ?, ?)`,
			).bind(newId(), attemptId, q.questionId, q.versionId, q.questionNumber),
		),

		env.DB.prepare(
			`UPDATE quiz_assignments
			    SET status = 'IN_PROGRESS', started_at = COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
			  WHERE id = ?`,
		).bind(attempt.assignmentId),

		// 재도전으로 만들어진 퀴즈는 배정만 먼저 생기고 상태는 REVIEW 에 머문다.
		// 두 경우를 모두 받아 준다.
		env.DB.prepare(
			`UPDATE quizzes SET status = 'IN_PROGRESS', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
			  WHERE id = ? AND status IN ('ASSIGNED', 'REVIEW')`,
		).bind(attempt.quizId),
	]);

	return attemptId;
}

/**
 * 이 Attempt 에 고정된 문항과 지금까지의 답.
 *
 * 본문·선택지·정답을 모두 `question_versions` 에서 읽는다. `questions` 를 읽으면 푸는 도중에
 * 부모가 고친 내용이 섞인다.
 */
export async function listQuestions(
	env: AppEnv,
	attemptId: string,
): Promise<AttemptQuestionRow[]> {
	const { results } = await env.DB.prepare(
		`SELECT aq.question_id, aq.question_version_id, aq.question_number,
		        v.question_text, v.choice1, v.choice2, v.choice3, v.choice4,
		        v.correct_choice, v.explanation, v.evidence,
		        a.selected_choice, a.is_correct
		   FROM attempt_questions aq
		   JOIN question_versions v ON v.id = aq.question_version_id
		   LEFT JOIN question_answers a
		          ON a.attempt_id = aq.attempt_id AND a.question_id = aq.question_id
		  WHERE aq.attempt_id = ?
		  ORDER BY aq.question_number`,
	)
		.bind(attemptId)
		.all<AttemptQuestionRow>();

	return results;
}

export interface NewAnswer {
	attemptId: string;
	questionId: string;
	questionVersionId: string;
	selectedChoice: number;
	correctChoice: number;
	isCorrect: boolean;
}

/**
 * 답을 기록하고 집계를 함께 올린다.
 *
 * 집계를 따로 계산해 UPDATE 하면 두 번 눌렀을 때 두 번 더해진다. 한 배치로 묶고, 답 자체는
 * `(attempt_id, question_id)` 유니크 인덱스가 막는다 — 두 번째 INSERT 가 실패하면 배치 전체가
 * 롤백되어 집계도 오르지 않는다.
 */
export async function recordAnswer(env: AppEnv, answer: NewAnswer): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO question_answers
			   (id, attempt_id, question_id, question_version_id, selected_choice, correct_choice, is_correct)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			newId(),
			answer.attemptId,
			answer.questionId,
			answer.questionVersionId,
			answer.selectedChoice,
			answer.correctChoice,
			answer.isCorrect ? 1 : 0,
		),
		env.DB.prepare(
			`UPDATE quiz_attempts
			    SET correct_count = correct_count + ?, wrong_count = wrong_count + ?
			  WHERE id = ?`,
		).bind(answer.isCorrect ? 1 : 0, answer.isCorrect ? 0 : 1, answer.attemptId),
	]);
}

/** 판을 끝낸다. 배정과 퀴즈 상태도 함께 옮긴다. */
export async function complete(
	env: AppEnv,
	attemptId: string,
	result: { score: number; passed: boolean },
): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(
			`UPDATE quiz_attempts
			    SET completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), score = ?, passed = ?
			  WHERE id = ? AND completed_at IS NULL`,
		).bind(result.score, result.passed ? 1 : 0, attemptId),

		env.DB.prepare(
			`UPDATE quiz_assignments
			    SET status = 'COMPLETED', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
			  WHERE id = (SELECT assignment_id FROM quiz_attempts WHERE id = ?)`,
		).bind(attemptId),

		env.DB.prepare(
			`UPDATE quizzes
			    SET status = 'COMPLETED', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
			  WHERE id = (SELECT quiz_id FROM quiz_attempts WHERE id = ?)`,
		).bind(attemptId),
	]);
}

export interface AttemptSummaryRow extends AttemptRow {
	book_title: string;
	quiz_round: number;
	question_count: number;
	pass_count: number;
	child_name: string;
}

/** 아이의 지난 판. 결과 화면과 부모 대시보드가 쓴다. */
export async function listForChild(
	env: AppEnv,
	childId: string,
	limit = 20,
): Promise<AttemptSummaryRow[]> {
	const { results } = await env.DB.prepare(
		`SELECT t.*, b.title AS book_title, z.round AS quiz_round,
		        z.question_count, z.pass_count, c.name AS child_name
		   FROM quiz_attempts t
		   JOIN quizzes  z ON z.id = t.quiz_id
		   JOIN books    b ON b.id = z.book_id
		   JOIN children c ON c.id = t.child_id
		  WHERE t.child_id = ?
		  ORDER BY t.created_at DESC
		  LIMIT ?`,
	)
		.bind(childId, limit)
		.all<AttemptSummaryRow>();

	return results;
}

export async function findSummary(
	env: AppEnv,
	attemptId: string,
): Promise<AttemptSummaryRow | null> {
	return env.DB.prepare(
		`SELECT t.*, b.title AS book_title, z.round AS quiz_round,
		        z.question_count, z.pass_count, c.name AS child_name
		   FROM quiz_attempts t
		   JOIN quizzes  z ON z.id = t.quiz_id
		   JOIN books    b ON b.id = z.book_id
		   JOIN children c ON c.id = t.child_id
		  WHERE t.id = ?`,
	)
		.bind(attemptId)
		.first<AttemptSummaryRow>();
}
