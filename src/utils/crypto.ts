import type { AppEnv } from "../types";
import { fromBase64, toBase64, utf8 } from "./base64";
import { ApiError } from "./response";

/**
 * 부모의 OPENAI_API_KEY 를 D1 에 보관하기 위한 AES-GCM 암복호화.
 *
 * 마스터 키는 Worker Secret(`ENCRYPTION_KEY`, base64 32바이트)이고 DB 에는 들어가지 않는다.
 * DB 가 통째로 유출돼도 마스터 키 없이는 API Key 를 복원할 수 없다.
 * IV 는 암호화할 때마다 새로 뽑아 같은 평문이라도 매번 다른 암호문이 되게 한다.
 */
const IV_BYTES = 12;
const KEY_BYTES = 32;

const misconfigured = (reason: string): ApiError => {
	// 값 자체는 절대 로그에 남기지 않는다. 길이만으로도 진단에는 충분하다.
	console.error(`ENCRYPTION_KEY misconfigured: ${reason}. openssl rand -base64 32 으로 재생성할 것`);
	return new ApiError("internal", "서버 암호화 키 설정이 올바르지 않습니다.", 500);
};

async function masterKey(env: AppEnv): Promise<CryptoKey> {
	let raw: Uint8Array;
	try {
		raw = fromBase64(env.ENCRYPTION_KEY ?? "");
	} catch {
		throw misconfigured("base64 로 디코딩할 수 없음");
	}
	if (raw.length !== KEY_BYTES) {
		throw misconfigured(`${KEY_BYTES}바이트여야 하는데 ${raw.length}바이트`);
	}
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export interface Sealed {
	cipher: string;
	iv: string;
}

export async function seal(env: AppEnv, plaintext: string): Promise<Sealed> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		await masterKey(env),
		utf8(plaintext),
	);
	return { cipher: toBase64(new Uint8Array(encrypted)), iv: toBase64(iv) };
}

export async function unseal(env: AppEnv, sealed: Sealed): Promise<string> {
	try {
		const decrypted = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: fromBase64(sealed.iv) },
			await masterKey(env),
			fromBase64(sealed.cipher),
		);
		return new TextDecoder().decode(decrypted);
	} catch (err) {
		if (err instanceof ApiError) throw err;
		// 마스터 키가 바뀌었거나 데이터가 손상된 경우. 부모에게 다시 입력하도록 안내한다.
		throw new ApiError("invalid", "저장된 API Key 를 복호화할 수 없습니다. 다시 입력해 주세요.", 400);
	}
}
