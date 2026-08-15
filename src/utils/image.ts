import { invalid } from "./response";

/**
 * 업로드 이미지 검증(§26).
 *
 * `Content-Type` 헤더는 클라이언트가 마음대로 적을 수 있으므로 믿지 않는다.
 * 실제 바이트의 시그니처(매직 바이트)로 포맷을 다시 확인한다.
 */

export const MAX_BYTES = 8 * 1024 * 1024;

export type ImageMime = "image/jpeg" | "image/png" | "image/webp" | "image/heic";

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0): boolean =>
	signature.every((byte, i) => bytes[offset + i] === byte);

/** 바이트만 보고 포맷을 판정한다. 알 수 없으면 null. */
export function detectImageMime(bytes: Uint8Array): ImageMime | null {
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";

	// RIFF....WEBP
	if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
		return "image/webp";
	}

	// ....ftyp<brand> — 아이폰 기본 촬영 포맷
	if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
		const brand = new TextDecoder().decode(bytes.slice(8, 12));
		if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return "image/heic";
	}

	return null;
}

/** 크기와 포맷을 확인하고 **실제** MIME 을 돌려준다. 헤더에 적힌 값은 무시한다. */
export function assertUploadedImage(bytes: Uint8Array): ImageMime {
	if (bytes.byteLength === 0) throw invalid("빈 파일입니다.");
	if (bytes.byteLength > MAX_BYTES) {
		throw invalid(`이미지는 ${Math.floor(MAX_BYTES / 1024 / 1024)}MB 이하만 올릴 수 있습니다.`);
	}

	const mime = detectImageMime(bytes);
	if (!mime) throw invalid("JPEG · PNG · WebP · HEIC 이미지만 올릴 수 있습니다.");
	return mime;
}

/** OpenAI Vision 에 넘길 data URL. 바이트를 그대로 base64 로 감싼다. */
export function toDataUrl(bytes: Uint8Array, mime: string): string {
	let binary = "";
	// 한 번에 apply 하면 인자 개수 한계에 걸린다. 청크로 나눠 붙인다.
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return `data:${mime};base64,${btoa(binary)}`;
}
