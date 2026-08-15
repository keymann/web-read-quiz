import * as childrenRepo from "../repositories/children";
import type { AppEnv, Principal } from "../types";
import type { ChildWithLogin } from "../repositories/children";
import { forbidden, notFound, unauthorized } from "../utils/response";

/**
 * 권한 가드.
 *
 * 원칙: 클라이언트가 보낸 `parentId`/`childId` 는 **신원**으로 절대 쓰지 않는다(§26).
 * 신원은 세션에서만 나오고, 클라이언트가 보낸 id 는 "이 리소스를 원한다"는 요청일 뿐이라
 * 항상 세션 신원과 대조해 소유 관계를 확인한다.
 */

export function requireAuth(principal: Principal | null): Principal {
	if (!principal) throw unauthorized();
	return principal;
}

export function requireParent(principal: Principal | null): Principal {
	const p = requireAuth(principal);
	if (p.role !== "PARENT") throw forbidden("부모 계정만 사용할 수 있습니다.");
	return p;
}

export interface ChildPrincipal extends Principal {
	childId: string;
}

export function requireChild(principal: Principal | null): ChildPrincipal {
	const p = requireAuth(principal);
	if (p.role !== "CHILD" || !p.childId) throw forbidden("아이 계정만 사용할 수 있습니다.");
	return { ...p, childId: p.childId };
}

/** 부모가 이 아이의 보호자인지 확인하고 아이 행을 돌려준다. */
export async function requireOwnedChild(
	env: AppEnv,
	principal: Principal | null,
	childId: string,
): Promise<ChildWithLogin> {
	const parent = requireParent(principal);
	const child = await childrenRepo.findOwned(env, parent.userId, childId);
	if (!child) throw notFound("아이를 찾을 수 없습니다.");
	return child;
}

/**
 * 부모와 아이 모두 접근할 수 있는 리소스용. 아이는 **자기 자신**일 때만 통과한다.
 * 부모/아이 어느 쪽으로 들어와도 같은 라우트를 쓸 수 있게 해준다.
 */
export async function requireChildAccess(
	env: AppEnv,
	principal: Principal | null,
	childId: string,
): Promise<void> {
	const p = requireAuth(principal);
	if (p.role === "CHILD") {
		if (p.childId !== childId) throw forbidden();
		return;
	}
	await requireOwnedChild(env, p, childId);
}
