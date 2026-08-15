/** WebCrypto 결과(ArrayBuffer)와 문자열 사이를 오가는 인코딩 도우미. */

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

export function fromBase64(s: string): Uint8Array {
	const binary = atob(s);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

export const toBase64Url = (bytes: Uint8Array): string =>
	toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function fromBase64Url(s: string): Uint8Array {
	const padded = s.replace(/-/g, "+").replace(/_/g, "/");
	return fromBase64(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

/** 길이가 달라도 조기 반환하지 않는 상수 시간 비교. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	let diff = a.length ^ b.length;
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
}
