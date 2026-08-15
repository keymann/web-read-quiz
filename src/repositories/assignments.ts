import type { AppEnv } from "../types";

/**
 * `quiz_assignments` 테이블 접근 — 부모가 만든 퀴즈를 아이에게 내보내는 기록(§13).
 *
 * 조회에는 `parent_user_id` 나 `child_id` 를 항상 `WHERE` 에 넣는다. 라우트 가드를 빠뜨려도
 * 남의 아이 데이터가 새지 않게 하는 두 번째 방어선이다(§21.5).
 */

export interface AssignmentRow {
	id: string;
	quiz_id: string;
	parent_user_id: string;
	child_id: string;
	status: "ASSIGNED" | "IN_PROGRESS" | "COMPLETED";
	assigned_at: string;
	started_at: string | null;
	completed_at: string | null;
}

export interface NewAssignment {
	id: string;
	quizId: string;
	parentUserId: string;
	childId: string;
}

export async function insert(env: AppEnv, assignment: NewAssignment): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO quiz_assignments (id, quiz_id, parent_user_id, child_id)
		 VALUES (?, ?, ?, ?)`,
	)
		.bind(assignment.id, assignment.quizId, assignment.parentUserId, assignment.childId)
		.run();
}

/** 아직 안 푼 것이 있으면 그것. 같은 퀴즈를 같은 아이에게 두 번 내보내지 않기 위해 본다. */
export async function findOpen(
	env: AppEnv,
	quizId: string,
	childId: string,
): Promise<AssignmentRow | null> {
	return env.DB.prepare(
		`SELECT * FROM quiz_assignments
		  WHERE quiz_id = ? AND child_id = ? AND status <> 'COMPLETED'`,
	)
		.bind(quizId, childId)
		.first<AssignmentRow>();
}

export interface AssignmentWithChild extends AssignmentRow {
	child_name: string;
}

/** 이 퀴즈가 누구에게 나가 있는지. 검수 화면에서 "이미 보냈다" 를 보여줄 때 쓴다. */
export async function listByQuiz(
	env: AppEnv,
	parentUserId: string,
	quizId: string,
): Promise<AssignmentWithChild[]> {
	const { results } = await env.DB.prepare(
		`SELECT a.*, c.name AS child_name
		   FROM quiz_assignments a
		   JOIN children c ON c.id = a.child_id
		  WHERE a.quiz_id = ? AND a.parent_user_id = ?
		  ORDER BY a.assigned_at DESC`,
	)
		.bind(quizId, parentUserId)
		.all<AssignmentWithChild>();
	return results;
}

export interface AssignmentWithBook extends AssignmentRow {
	book_title: string;
	question_count: number;
	pass_count: number;
}

/** 아이 화면에 보여줄 "받은 퀴즈". 아직 안 끝난 것만. */
export async function listForChild(env: AppEnv, childId: string): Promise<AssignmentWithBook[]> {
	const { results } = await env.DB.prepare(
		`SELECT a.*, b.title AS book_title, q.question_count, q.pass_count
		   FROM quiz_assignments a
		   JOIN quizzes q ON q.id = a.quiz_id
		   JOIN books b   ON b.id = q.book_id
		  WHERE a.child_id = ? AND a.status <> 'COMPLETED'
		  ORDER BY a.assigned_at DESC`,
	)
		.bind(childId)
		.all<AssignmentWithBook>();
	return results;
}
