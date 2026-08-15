import { fromBase64, toBase64Url, utf8 } from "../utils/base64";
import { invalid } from "../utils/response";

/**
 * GCP 서비스 계정 → OAuth2 액세스 토큰.
 *
 * Vertex AI 는 API Key 를 받지 않는다. 서비스 계정 키로 JWT 를 만들어 서명하고, 그것을
 * 구글 토큰 엔드포인트에서 액세스 토큰으로 바꿔야 한다. Workers 에는 google-auth-library 를
 * 쓸 수 없으므로 WebCrypto 로 직접 한다.
 *
 *   서비스 계정 JSON → JWT(RS256 서명) → POST oauth2.googleapis.com/token → access_token(1시간)
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const JWT_LIFETIME_SECONDS = 3600;

export interface ServiceAccount {
	type: string;
	project_id: string;
	private_key_id: string;
	private_key: string;
	client_email: string;
}

/** 서비스 계정 JSON 문자열을 검증하며 파싱한다. 형식이 어긋나면 무엇이 빠졌는지 알려준다. */
export function parseServiceAccount(raw: string): ServiceAccount {
	let parsed: Partial<ServiceAccount>;
	try {
		parsed = JSON.parse(raw) as Partial<ServiceAccount>;
	} catch {
		throw invalid("서비스 계정 JSON 을 읽을 수 없습니다. 파일 내용을 통째로 붙여넣어 주세요.");
	}

	if (parsed.type !== "service_account") {
		throw invalid('서비스 계정 키가 아닙니다. "type": "service_account" 인 JSON 이어야 합니다.');
	}

	for (const field of ["project_id", "private_key", "client_email"] as const) {
		if (typeof parsed[field] !== "string" || parsed[field]!.trim() === "") {
			throw invalid(`서비스 계정 JSON 에 ${field} 가 없습니다.`);
		}
	}
	if (!parsed.private_key!.includes("BEGIN PRIVATE KEY")) {
		throw invalid("private_key 형식이 올바르지 않습니다. 파일을 그대로 붙여넣었는지 확인해 주세요.");
	}

	return parsed as ServiceAccount;
}

/** PEM(PKCS#8) → WebCrypto 서명 키. */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
	// JSON 안에서는 줄바꿈이 \n 문자열로 들어 있다. 실제 개행으로 되돌린 뒤 헤더를 벗긴다.
	const body = pem
		.replace(/\\n/g, "\n")
		.replace(/-----BEGIN PRIVATE KEY-----/, "")
		.replace(/-----END PRIVATE KEY-----/, "")
		.replace(/\s/g, "");

	return crypto.subtle.importKey(
		"pkcs8",
		fromBase64(body),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
}

async function signJwt(account: ServiceAccount): Promise<string> {
	const now = Math.floor(Date.now() / 1000);

	const header = toBase64Url(
		utf8(JSON.stringify({ alg: "RS256", typ: "JWT", kid: account.private_key_id })),
	);
	const claims = toBase64Url(
		utf8(
			JSON.stringify({
				iss: account.client_email,
				scope: SCOPE,
				aud: TOKEN_URL,
				iat: now,
				exp: now + JWT_LIFETIME_SECONDS,
			}),
		),
	);

	const data = `${header}.${claims}`;
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		await importPrivateKey(account.private_key),
		utf8(data),
	);

	return `${data}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * 액세스 토큰 캐시.
 *
 * 토큰은 1시간 유효한데 매 호출마다 새로 받으면 왕복이 하나씩 더 붙는다.
 * KV 대신 아이솔레이트 메모리에 둔다 — 제공자 인터페이스에 env 를 끌어들이지 않아도 되고,
 * 아이솔레이트가 새로 뜨면 한 번 더 받으면 그만이다. 가족 단위 사용량에서는 이걸로 충분하다.
 */
const cache = new Map<string, { token: string; expiresAt: number }>();

/** 만료 직전에 갱신해 경계에서 401 이 나지 않게 한다. */
const EXPIRY_MARGIN_MS = 60_000;

export async function getAccessToken(account: ServiceAccount): Promise<string> {
	const key = `${account.client_email}:${account.private_key_id}`;
	const cached = cache.get(key);
	if (cached && cached.expiresAt > Date.now() + EXPIRY_MARGIN_MS) return cached.token;

	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion: await signJwt(account),
		}),
		signal: AbortSignal.timeout(15_000),
	});

	if (!response.ok) {
		let detail = "";
		try {
			const body = (await response.json()) as { error_description?: string; error?: string };
			detail = body.error_description ?? body.error ?? "";
		} catch {
			/* 본문이 JSON 이 아니면 상태 코드만으로 판단한다 */
		}
		console.error(`google token ${response.status}: ${detail.slice(0, 200)}`);
		throw invalid(
			`서비스 계정으로 인증하지 못했습니다. 키가 유효한지, Vertex AI API 가 켜져 있는지 확인해 주세요. (${detail || response.status})`,
		);
	}

	const body = (await response.json()) as { access_token: string; expires_in: number };
	cache.set(key, {
		token: body.access_token,
		expiresAt: Date.now() + body.expires_in * 1000,
	});

	return body.access_token;
}
