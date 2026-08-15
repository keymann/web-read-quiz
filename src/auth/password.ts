import { fromBase64, timingSafeEqual, toBase64, utf8 } from "../utils/base64";

/**
 * 비밀번호 해시 — PBKDF2-SHA256.
 *
 * Workers 런타임에는 bcrypt/argon2 가 없다. WebCrypto 만으로 추가 의존성 없이 처리한다.
 * 저장 포맷: `pbkdf2$<iterations>$<salt-b64>$<hash-b64>`
 * iterations 를 포맷에 담아 두어 나중에 값을 올려도 기존 해시를 계속 검증할 수 있다.
 */
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt, iterations, hash: "SHA-256" },
		key,
		KEY_BITS,
	);
	return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const hash = await derive(password, salt, ITERATIONS);
	return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split("$");
	if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;

	const iterations = Number(parts[1]);
	if (!Number.isInteger(iterations) || iterations < 1000) return false;

	try {
		const actual = await derive(password, fromBase64(parts[2]!), iterations);
		return timingSafeEqual(actual, fromBase64(parts[3]!));
	} catch {
		return false;
	}
}
