import type { AppEnv, ChoiceNumber, Difficulty, QuestionHistoryAction, QuestionType } from "../types";
import { newId } from "../utils/id";

/**
 * `questions` + `question_versions` + `question_histories` 접근.
 *
 * 이 셋은 **항상 함께** 쓴다. 문제를 만들거나 고칠 때마다 불변 버전과 감사 로그가 같이 남아야
 * 과거 Attempt 를 재구성할 수 있다(§22). 그래서 batch 한 트랜잭션으로 묶는다.
 */

export interface QuestionRow {
	id: string;
	quiz_id: string;
	question_number: number;
	question_text: string;
	choice1: string;
	choice2: string;
	choice3: string;
	choice4: string;
	correct_choice: number;
	question_type: QuestionType;
	difficulty: number;
	explanation: string | null;
	evidence: string | null;
	read_required: number;
	is_active: number;
	current_version: number;
	created_at: string;
	updated_at: string;
}

export interface NewQuestion {
	quizId: string;
	questionNumber: number;
	questionText: string;
	choices: string[];
	correctChoice: ChoiceNumber;
	questionType: QuestionType;
	difficulty: Difficulty;
	explanation: string;
	evidence: string;
	readRequired: boolean;
}

export interface ValidationRecord {
	valid: boolean;
	score: number;
	reason: string;
	readRequired: boolean;
}

/**
 * 문제 한 벌을 저장한다. 문항마다 questions · question_versions(v1) ·
 * question_histories(AI_GENERATED) · question_validations 를 함께 쓴다.
 */
export async function insertGenerated(
	env: AppEnv,
	questions: NewQuestion[],
	action: QuestionHistoryAction,
	validations: Map<number, ValidationRecord>,
): Promise<void> {
	if (questions.length === 0) return;

	const statements: D1PreparedStatement[] = [];

	for (const q of questions) {
		const questionId = newId();
		const versionId = newId();

		statements.push(
			env.DB.prepare(
				`INSERT INTO questions
				   (id, quiz_id, question_number, question_text, choice1, choice2, choice3, choice4,
				    correct_choice, question_type, difficulty, explanation, evidence, read_required, current_version)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
			).bind(
				questionId,
				q.quizId,
				q.questionNumber,
				q.questionText,
				q.choices[0]!,
				q.choices[1]!,
				q.choices[2]!,
				q.choices[3]!,
				q.correctChoice,
				q.questionType,
				q.difficulty,
				q.explanation,
				q.evidence,
				q.readRequired ? 1 : 0,
			),
			env.DB.prepare(
				`INSERT INTO question_versions
				   (id, question_id, version, question_text, choice1, choice2, choice3, choice4,
				    correct_choice, question_type, difficulty, explanation, evidence, read_required, created_by)
				 VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AI')`,
			).bind(
				versionId,
				questionId,
				q.questionText,
				q.choices[0]!,
				q.choices[1]!,
				q.choices[2]!,
				q.choices[3]!,
				q.correctChoice,
				q.questionType,
				q.difficulty,
				q.explanation,
				q.evidence,
				q.readRequired ? 1 : 0,
			),
			env.DB.prepare(
				`INSERT INTO question_histories (id, question_id, action, old_data, new_data, actor_type, actor_id)
				 VALUES (?, ?, ?, NULL, ?, 'AI', NULL)`,
			).bind(newId(), questionId, action, JSON.stringify(q)),
		);

		const verdict = validations.get(q.questionNumber);
		if (verdict) {
			statements.push(
				env.DB.prepare(
					`INSERT INTO question_validations
					   (id, question_id, question_version_id, valid, score, reason, read_required)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				).bind(
					newId(),
					questionId,
					versionId,
					verdict.valid ? 1 : 0,
					verdict.score,
					verdict.reason,
					verdict.readRequired ? 1 : 0,
				),
			);
		}
	}

	await env.DB.batch(statements);
}

export async function listActive(env: AppEnv, quizId: string): Promise<QuestionRow[]> {
	const { results } = await env.DB.prepare(
		"SELECT * FROM questions WHERE quiz_id = ? AND is_active = 1 ORDER BY question_number",
	)
		.bind(quizId)
		.all<QuestionRow>();
	return results;
}

export async function countActive(env: AppEnv, quizId: string): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) AS c FROM questions WHERE quiz_id = ? AND is_active = 1",
	)
		.bind(quizId)
		.first<{ c: number }>();
	return row?.c ?? 0;
}

/** 생성을 다시 돌릴 때 이전 시도의 문항을 치운다. 행은 남기고 비활성화만 한다(§21.7). */
export async function deactivateAll(env: AppEnv, quizId: string): Promise<void> {
	await env.DB.prepare(
		`UPDATE questions
		    SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		  WHERE quiz_id = ? AND is_active = 1`,
	)
		.bind(quizId)
		.run();
}
