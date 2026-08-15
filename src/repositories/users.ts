import type { AppEnv, Role, UserRow } from "../types";

/**
 * `users` 테이블 접근. SQL 은 이 레이어 밖으로 나가지 않는다(§31.3).
 * 모든 쿼리는 `.bind()` 파라미터를 쓴다 — 문자열 결합으로 SQL 을 만들지 않는다(§26).
 */

export async function findByLoginId(env: AppEnv, loginId: string): Promise<UserRow | null> {
	return env.DB.prepare("SELECT * FROM users WHERE login_id = ?").bind(loginId).first<UserRow>();
}

export async function findById(env: AppEnv, id: string): Promise<UserRow | null> {
	return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function loginIdExists(env: AppEnv, loginId: string): Promise<boolean> {
	const row = await env.DB.prepare("SELECT 1 AS x FROM users WHERE login_id = ?")
		.bind(loginId)
		.first<{ x: number }>();
	return row !== null;
}

export interface NewUser {
	id: string;
	loginId: string;
	passwordHash: string;
	role: Role;
	displayName: string;
}

/** INSERT 문만 만들어 돌려준다. 아이 계정처럼 다른 INSERT 와 한 트랜잭션으로 묶기 위해서다. */
export function insertUserStatement(env: AppEnv, user: NewUser): D1PreparedStatement {
	return env.DB.prepare(
		`INSERT INTO users (id, login_id, password_hash, role, display_name)
		 VALUES (?, ?, ?, ?, ?)`,
	).bind(user.id, user.loginId, user.passwordHash, user.role, user.displayName);
}

export async function insertUser(env: AppEnv, user: NewUser): Promise<void> {
	await insertUserStatement(env, user).run();
}

export async function updatePassword(
	env: AppEnv,
	userId: string,
	passwordHash: string,
): Promise<void> {
	await env.DB.prepare(
		`UPDATE users
		    SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		  WHERE id = ?`,
	)
		.bind(passwordHash, userId)
		.run();
}

export function setActiveStatement(
	env: AppEnv,
	userId: string,
	active: boolean,
): D1PreparedStatement {
	return env.DB.prepare(
		`UPDATE users
		    SET is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		  WHERE id = ?`,
	).bind(active ? 1 : 0, userId);
}
