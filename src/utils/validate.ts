import { invalid } from "./response";

/** 입력 검증. 라우트 레이어에서만 쓰고, 통과한 값만 서비스로 내린다. */

/** 한글·영문·숫자·밑줄 2~20자. 아이가 직접 입력하므로 특수문자는 받지 않는다. */
const LOGIN_ID_RE = /^[가-힣a-zA-Z0-9_]{2,20}$/;

export async function readJson(request: Request): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw invalid("요청 본문을 읽을 수 없습니다.");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw invalid("요청 본문이 올바르지 않습니다.");
	}
	return body as Record<string, unknown>;
}

export function str(body: Record<string, unknown>, field: string, label: string): string {
	const value = body[field];
	if (typeof value !== "string" || value.trim() === "") throw invalid(`${label}을(를) 입력해 주세요.`);
	return value.trim();
}

export function optionalStr(body: Record<string, unknown>, field: string): string | undefined {
	const value = body[field];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw invalid("입력 형식이 올바르지 않습니다.");
	return value.trim();
}

export function loginId(body: Record<string, unknown>, field = "loginId"): string {
	const value = str(body, field, "아이디");
	if (!LOGIN_ID_RE.test(value)) {
		throw invalid("아이디는 한글·영문·숫자 2~20자로 입력해 주세요.");
	}
	return value;
}

export function password(body: Record<string, unknown>, field: string, minLength: number): string {
	const value = body[field];
	if (typeof value !== "string" || value.length < minLength) {
		throw invalid(`비밀번호는 ${minLength}자 이상이어야 합니다.`);
	}
	if (value.length > 200) throw invalid("비밀번호가 너무 깁니다.");
	return value;
}

export function displayName(body: Record<string, unknown>, field = "displayName"): string {
	const value = str(body, field, "이름");
	if (value.length > 20) throw invalid("이름은 20자 이내로 입력해 주세요.");
	return value;
}

/** 초등 1~6학년. 미입력 허용. */
export function grade(body: Record<string, unknown>, field = "grade"): number | null {
	const value = body[field];
	if (value === undefined || value === null || value === "") return null;
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isInteger(n) || n < 1 || n > 6) throw invalid("학년은 1~6 사이로 입력해 주세요.");
	return n;
}
