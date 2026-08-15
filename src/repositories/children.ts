import type { AppEnv, ChildRow } from "../types";

/**
 * `children` 테이블 접근.
 *
 * 조회 쿼리에는 `parent_user_id` 를 항상 `WHERE` 에 넣는다. 라우트에서 가드를 빠뜨리더라도
 * 남의 아이 데이터가 나오지 않도록 하는 두 번째 방어선이다(§21.5).
 */

export interface ChildWithLogin extends ChildRow {
	login_id: string | null;
}

export async function listByParent(env: AppEnv, parentUserId: string): Promise<ChildWithLogin[]> {
	const { results } = await env.DB.prepare(
		`SELECT c.*, u.login_id
		   FROM children c
		   LEFT JOIN users u ON u.id = c.child_user_id
		  WHERE c.parent_user_id = ? AND c.is_active = 1
		  ORDER BY c.created_at`,
	)
		.bind(parentUserId)
		.all<ChildWithLogin>();
	return results;
}

/** 부모 소유일 때만 반환한다. 소유가 아니면 null — 존재 여부 자체를 알려주지 않는다. */
export async function findOwned(
	env: AppEnv,
	parentUserId: string,
	childId: string,
): Promise<ChildWithLogin | null> {
	return env.DB.prepare(
		`SELECT c.*, u.login_id
		   FROM children c
		   LEFT JOIN users u ON u.id = c.child_user_id
		  WHERE c.id = ? AND c.parent_user_id = ? AND c.is_active = 1`,
	)
		.bind(childId, parentUserId)
		.first<ChildWithLogin>();
}

/** 아이 본인 세션에서 자기 프로필을 찾을 때. */
export async function findByChildUserId(env: AppEnv, childUserId: string): Promise<ChildRow | null> {
	return env.DB.prepare(
		"SELECT * FROM children WHERE child_user_id = ? AND is_active = 1",
	)
		.bind(childUserId)
		.first<ChildRow>();
}

export interface NewChild {
	id: string;
	parentUserId: string;
	childUserId: string;
	name: string;
	grade: number | null;
}

export function insertChildStatement(env: AppEnv, child: NewChild): D1PreparedStatement {
	return env.DB.prepare(
		`INSERT INTO children (id, parent_user_id, child_user_id, name, grade)
		 VALUES (?, ?, ?, ?, ?)`,
	).bind(child.id, child.parentUserId, child.childUserId, child.name, child.grade);
}

export async function updateProfile(
	env: AppEnv,
	parentUserId: string,
	childId: string,
	fields: { name?: string; grade?: number | null },
): Promise<void> {
	const sets: string[] = [];
	const values: (string | number | null)[] = [];

	if (fields.name !== undefined) {
		sets.push("name = ?");
		values.push(fields.name);
	}
	if (fields.grade !== undefined) {
		sets.push("grade = ?");
		values.push(fields.grade);
	}
	if (sets.length === 0) return;

	sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
	values.push(childId, parentUserId);

	await env.DB.prepare(
		`UPDATE children SET ${sets.join(", ")} WHERE id = ? AND parent_user_id = ?`,
	)
		.bind(...values)
		.run();
}

/** 행을 지우지 않는다. 지우면 CASCADE 로 과거 풀이 기록까지 사라진다(§21.7). */
export function deactivateStatement(
	env: AppEnv,
	parentUserId: string,
	childId: string,
): D1PreparedStatement {
	return env.DB.prepare(
		`UPDATE children
		    SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		  WHERE id = ? AND parent_user_id = ?`,
	).bind(childId, parentUserId);
}
