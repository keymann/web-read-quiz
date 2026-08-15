import { requireOwnedChild, requireParent } from "../auth/guards";
import { hashPassword } from "../auth/password";
import * as childrenRepo from "../repositories/children";
import type { ChildWithLogin } from "../repositories/children";
import * as usersRepo from "../repositories/users";
import type { ChildView } from "../types";
import { newId } from "../utils/id";
import { conflict, invalid, ok } from "../utils/response";
import * as v from "../utils/validate";
import { rateLimit } from "../utils/ratelimit";
import { route, type Route, type RouteCtx } from "./router";

/** 아이는 자기 비밀번호를 직접 입력해야 하므로 부모보다 짧게 허용한다. */
const CHILD_PASSWORD_MIN = 4;

const toView = (c: ChildWithLogin): ChildView => ({
	id: c.id,
	name: c.name,
	grade: c.grade,
	loginId: c.login_id,
	createdAt: c.created_at,
});

async function list({ env, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	const rows = await childrenRepo.listByParent(env, parent.userId);
	return ok({ children: rows.map(toView) });
}

/**
 * 한 부모가 등록할 수 있는 아이 수.
 *
 * 아이를 추가할 때마다 로그인 계정(`users` 행)이 하나씩 생긴다. 막지 않으면 부모 계정 하나로
 * 계정을 무한히 찍어낼 수 있다. 한 가정에 이보다 많을 일은 없다.
 */
const MAX_CHILDREN = 20;

async function create({ request, env, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	// 등록 자체는 아래 MAX_CHILDREN 이 막는다. 이 제한은 **시도**를 묶는 것이다 —
	// 실패하는 요청도 비밀번호 해시(PBKDF2 10만 회)를 돌리므로 CPU 가 든다.
	// 한도(20)보다 높게 잡아야 정상 사용자가 한도에 닿기 전에 막히지 않는다.
	await rateLimit(env, "child-create", parent.userId, 30, 60 * 60);

	if ((await childrenRepo.listByParent(env, parent.userId)).length >= MAX_CHILDREN) {
		throw conflict(`아이는 ${MAX_CHILDREN}명까지 등록할 수 있습니다.`);
	}

	const body = await v.readJson(request);
	const name = v.displayName(body, "name");
	const grade = v.grade(body);
	const id = v.loginId(body);
	const pw = v.password(body, "password", CHILD_PASSWORD_MIN);

	if (await usersRepo.loginIdExists(env, id)) throw conflict("이미 사용 중인 아이디입니다.");

	const childUserId = newId();
	const childId = newId();

	// 계정과 프로필은 함께 만들어져야 한다. batch 는 하나의 트랜잭션으로 실행된다.
	await env.DB.batch([
		usersRepo.insertUserStatement(env, {
			id: childUserId,
			loginId: id,
			passwordHash: await hashPassword(pw),
			role: "CHILD",
			displayName: name,
		}),
		childrenRepo.insertChildStatement(env, {
			id: childId,
			parentUserId: parent.userId,
			childUserId,
			name,
			grade,
		}),
	]);

	return ok({ child: { id: childId, name, grade, loginId: id } }, 201);
}

async function update({ request, env, principal, params }: RouteCtx): Promise<Response> {
	const child = await requireOwnedChild(env, principal, params.id!);
	const body = await v.readJson(request);

	const name = "name" in body ? v.displayName(body, "name") : undefined;
	const grade = "grade" in body ? v.grade(body) : undefined;
	const newPassword = "password" in body ? v.password(body, "password", CHILD_PASSWORD_MIN) : undefined;

	if (name === undefined && grade === undefined && newPassword === undefined) {
		throw invalid("변경할 내용이 없습니다.");
	}

	await childrenRepo.updateProfile(env, child.parent_user_id, child.id, {
		...(name !== undefined ? { name } : {}),
		...(grade !== undefined ? { grade } : {}),
	});

	if (newPassword !== undefined && child.child_user_id) {
		await usersRepo.updatePassword(env, child.child_user_id, await hashPassword(newPassword));
	}

	const updated = await childrenRepo.findOwned(env, child.parent_user_id, child.id);
	return ok({ child: updated ? toView(updated) : null });
}

/**
 * 아이 삭제 = 비활성화. 행을 지우면 CASCADE 로 과거 퀴즈·풀이 기록까지 사라진다(§21.7).
 * 로그인 계정도 함께 비활성화해 더 이상 접속하지 못하게 한다.
 */
async function deactivate({ env, principal, params }: RouteCtx): Promise<Response> {
	const child = await requireOwnedChild(env, principal, params.id!);

	const statements = [childrenRepo.deactivateStatement(env, child.parent_user_id, child.id)];
	if (child.child_user_id) {
		statements.push(usersRepo.setActiveStatement(env, child.child_user_id, false));
	}
	await env.DB.batch(statements);

	return ok({ deactivated: true });
}

export const childrenRoutes: Route[] = [
	route("GET", "/api/children", list),
	route("POST", "/api/children", create),
	route("PATCH", "/api/children/:id", update),
	route("DELETE", "/api/children/:id", deactivate),
];
