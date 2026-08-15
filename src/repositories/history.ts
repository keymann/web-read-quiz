import type { AppEnv, QuestionHistoryAction } from "../types";

/**
 * 이력 조회 전용 리포지토리.
 *
 * 부모가 "AI 가 무엇을 만들었고 내가 무엇을 고쳤는지"(§12), "아이가 무엇을 어떻게 답했는지"(§16)를
 * 한 화면에서 볼 수 있어야 한다. 두 이력은 성격이 달라 쿼리를 나눈다.
 *
 * 모든 쿼리에 `quizzes.parent_user_id = ?` 를 넣어 남의 이력이 새지 않게 한다(§21.5).
 */

export interface QuestionHistoryEntry {
	id: string;
	created_at: string;
	action: QuestionHistoryAction;
	actor_type: string;
	old_data: string | null;
	new_data: string | null;
	question_number: number;
	question_text: string;
	quiz_id: string;
	quiz_round: number;
	book_title: string;
}

export interface HistoryFilter {
	bookId?: string;
	quizId?: string;
	limit: number;
	offset: number;
}

export async function listQuestionHistory(
	env: AppEnv,
	parentUserId: string,
	filter: HistoryFilter,
): Promise<QuestionHistoryEntry[]> {
	const conditions = ["z.parent_user_id = ?"];
	const values: (string | number)[] = [parentUserId];

	if (filter.bookId) {
		conditions.push("z.book_id = ?");
		values.push(filter.bookId);
	}
	if (filter.quizId) {
		conditions.push("z.id = ?");
		values.push(filter.quizId);
	}
	values.push(filter.limit, filter.offset);

	const { results } = await env.DB.prepare(
		`SELECT h.id, h.created_at, h.action, h.actor_type, h.old_data, h.new_data,
		        q.question_number, q.question_text,
		        z.id AS quiz_id, z.round AS quiz_round,
		        b.title AS book_title
		   FROM question_histories h
		   JOIN questions q ON q.id = h.question_id
		   JOIN quizzes   z ON z.id = q.quiz_id
		   JOIN books     b ON b.id = z.book_id
		  WHERE ${conditions.join(" AND ")}
		  ORDER BY h.created_at DESC, q.question_number
		  LIMIT ? OFFSET ?`,
	)
		.bind(...values)
		.all<QuestionHistoryEntry>();

	return results;
}

export interface AnswerHistoryEntry {
	id: string;
	answered_at: string;
	selected_choice: number;
	correct_choice: number;
	is_correct: number;
	question_number: number;
	question_text: string;
	/** 아이가 실제로 본 문항 본문. 이후 문제가 수정돼도 이 값은 변하지 않는다(§22). */
	shown_text: string;
	child_name: string;
	quiz_round: number;
	book_title: string;
	attempt_id: string;
}

export async function listAnswerHistory(
	env: AppEnv,
	parentUserId: string,
	filter: HistoryFilter & { childId?: string },
): Promise<AnswerHistoryEntry[]> {
	const conditions = ["z.parent_user_id = ?"];
	const values: (string | number)[] = [parentUserId];

	if (filter.bookId) {
		conditions.push("z.book_id = ?");
		values.push(filter.bookId);
	}
	if (filter.quizId) {
		conditions.push("z.id = ?");
		values.push(filter.quizId);
	}
	if (filter.childId) {
		conditions.push("c.id = ?");
		values.push(filter.childId);
	}
	values.push(filter.limit, filter.offset);

	// question_versions 를 조인해 **아이가 그때 본 문항 본문**을 가져온다.
	// questions 를 그대로 읽으면 부모가 나중에 고친 문장이 과거 기록에 섞인다.
	const { results } = await env.DB.prepare(
		`SELECT a.id, a.answered_at, a.selected_choice, a.correct_choice, a.is_correct,
		        q.question_number, q.question_text,
		        v.question_text AS shown_text,
		        c.name AS child_name,
		        z.round AS quiz_round,
		        b.title AS book_title,
		        a.attempt_id
		   FROM question_answers a
		   JOIN questions          q ON q.id = a.question_id
		   JOIN question_versions  v ON v.id = a.question_version_id
		   JOIN quiz_attempts      t ON t.id = a.attempt_id
		   JOIN children           c ON c.id = t.child_id
		   JOIN quizzes            z ON z.id = q.quiz_id
		   JOIN books              b ON b.id = z.book_id
		  WHERE ${conditions.join(" AND ")}
		  ORDER BY a.answered_at DESC
		  LIMIT ? OFFSET ?`,
	)
		.bind(...values)
		.all<AnswerHistoryEntry>();

	return results;
}

/** 이력 화면의 필터 선택지. 부모가 가진 책만 보여준다. */
export async function listBooksWithHistory(
	env: AppEnv,
	parentUserId: string,
): Promise<{ id: string; title: string }[]> {
	const { results } = await env.DB.prepare(
		`SELECT DISTINCT b.id, b.title
		   FROM books b
		   JOIN quizzes z ON z.book_id = b.id
		  WHERE z.parent_user_id = ?
		  ORDER BY b.title`,
	)
		.bind(parentUserId)
		.all<{ id: string; title: string }>();
	return results;
}
