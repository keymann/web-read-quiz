import { invalid } from "./response";

/** 입력 검증. 라우트 레이어에서만 쓰고, 통과한 값만 서비스로 내린다. */

/** 한글·영문·숫자·밑줄 2~20자. 아이가 직접 입력하므로 특수문자는 받지 않는다. */
const LOGIN_ID_RE = /^[가-힣a-zA-Z0-9_]{2,20}$/;

/**
 * JSON 본문 상한(§26).
 *
 * 가장 큰 정상 요청은 브라우저 릴레이가 돌려주는 Gemini 응답(20문항 + 검수 결과)으로
 * 50KB 안팎이다. 1MB 는 그 스무 배로, 정상 요청은 절대 닿지 않으면서 "본문을 통째로
 * 메모리에 올린 뒤에야 이상함을 아는" 상황을 막는다.
 */
const MAX_JSON_BYTES = 1024 * 1024;

export async function readJson(request: Request): Promise<Record<string, unknown>> {
	// 헤더가 있으면 읽기 전에 거른다. chunked 라 없을 수도 있어 아래에서 한 번 더 본다.
	const declared = Number(request.headers.get("Content-Length") ?? "0");
	if (declared > MAX_JSON_BYTES) throw invalid("요청 본문이 너무 큽니다.");

	let text: string;
	try {
		text = await request.text();
	} catch {
		throw invalid("요청 본문을 읽을 수 없습니다.");
	}
	if (text.length > MAX_JSON_BYTES) throw invalid("요청 본문이 너무 큽니다.");

	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw invalid("요청 본문을 읽을 수 없습니다.");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw invalid("요청 본문이 올바르지 않습니다.");
	}
	return body as Record<string, unknown>;
}

/**
 * 문자열 배열. 개수와 각 항목의 길이를 모두 제한한다.
 *
 * 배열을 그대로 받아 쓰면 클라이언트가 길이로 서버를 밀어붙일 수 있다. 실제로 이 앱에는
 * id 목록을 `IN (?, ?, …)` 로 펼치는 자리가 있어, 개수를 막지 않으면 SQL 문 자체가 거대해진다.
 */
export function strArray(
	body: Record<string, unknown>,
	field: string,
	{ max, maxLength = 200 }: { max: number; maxLength?: number },
): string[] {
	const value = body[field];
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw invalid("목록 형식이 올바르지 않습니다.");
	if (value.length > max) throw invalid(`한 번에 ${max}개까지만 보낼 수 있습니다.`);

	return value.map((item) => {
		if (typeof item !== "string" || item.length > maxLength) {
			throw invalid("목록 형식이 올바르지 않습니다.");
		}
		return item;
	});
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
