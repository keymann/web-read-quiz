import * as assignmentsRepo from "../repositories/assignments";
import * as childrenRepo from "../repositories/children";
import * as questionsRepo from "../repositories/questions";
import * as quizzesRepo from "../repositories/quizzes";
import type { AppEnv } from "../types";
import { newId } from "../utils/id";
import { conflict, invalid, notFound } from "../utils/response";

/**
 * 퀴즈를 아이에게 내보낸다(§13).
 *
 * 문제를 다 만들어 놓고도 아이에게 보낼 방법이 없으면 파이프라인이 거기서 끊긴다.
 * 검수 화면에서 아이를 고르면 이 서비스가 배정을 만든다.
 */

export interface AssignResult {
	assignmentId: string;
	childId: string;
	childName: string;
}

/**
 * 내보내기 전에 확인하는 것:
 *  - 이 부모의 퀴즈이고 이 부모의 아이인가
 *  - 문항이 목표만큼 다 찼는가 — 덜 만든 퀴즈가 나가면 아이가 중간에 멈춘다
 *  - 이미 이 아이에게 나가 있지 않은가
 */
export async function assign(
	env: AppEnv,
	userId: string,
	quizId: string,
	childId: string,
): Promise<AssignResult> {
	const quiz = await quizzesRepo.findOwned(env, userId, quizId);
	if (!quiz) throw notFound("퀴즈를 찾을 수 없습니다.");

	const child = await childrenRepo.findOwned(env, userId, childId);
	if (!child) throw notFound("아이를 찾을 수 없습니다.");

	if (quiz.status === "GENERATING") throw conflict("아직 문제를 만들고 있습니다.");

	const ready = await questionsRepo.countActive(env, quizId);
	if (ready < quiz.question_count) {
		throw invalid(
			`아직 ${quiz.question_count - ready}문제가 부족합니다. 문제를 모두 만든 뒤 보내 주세요.`,
		);
	}

	if (await assignmentsRepo.findOpen(env, quizId, childId)) {
		throw conflict(`${child.name} 에게 이미 보낸 퀴즈입니다.`);
	}

	const assignmentId = newId();
	await assignmentsRepo.insert(env, { id: assignmentId, quizId, parentUserId: userId, childId });
	await quizzesRepo.setStatus(env, quizId, "ASSIGNED");

	return { assignmentId, childId, childName: child.name };
}

export interface AssignmentView {
	id: string;
	childId: string;
	childName: string;
	status: string;
	assignedAt: string;
}

export async function listForQuiz(
	env: AppEnv,
	userId: string,
	quizId: string,
): Promise<AssignmentView[]> {
	const rows = await assignmentsRepo.listByQuiz(env, userId, quizId);
	return rows.map((row) => ({
		id: row.id,
		childId: row.child_id,
		childName: row.child_name,
		status: row.status,
		assignedAt: row.assigned_at,
	}));
}
