/**
 * 업로드 전에 브라우저에서 이미지를 줄인다.
 *
 * Workers 런타임에는 이미지 디코더가 없어 서버에서 축소할 수 없다. 클라이언트에서 줄이면
 * 업로드도 빨라지고 Vision 호출의 토큰도 아낀다. 아이폰의 HEIC 도 canvas 를 거치며 JPEG 이 된다.
 *
 * 크기 검증과 포맷 검증은 서버가 다시 한다. 여기서 하는 일은 최적화일 뿐, 신뢰 경계가 아니다.
 */

/**
 * 저장·전송 규격.
 *
 * 표지 원본을 그대로 둘 이유가 없다. 이 이미지는 **AI 가 글자를 읽는 용도**로만 쓰이고
 * 화면에는 썸네일 크기로만 보인다. 원본을 보관하면 KV 용량과 Vision 토큰만 먹는다.
 *
 * 1024px / 0.72 는 제목·지은이·출판사가 또렷하게 읽히는 하한선 근처다. 실제 표지로
 * 확인했을 때 이 값에서 네 항목이 모두 정확히 읽혔다. 여기서 더 줄이면 뒤표지 바코드
 * 아래 ISBN 처럼 작은 글씨부터 무너진다.
 */
const MAX_EDGE = 1024;
const QUALITY = 0.72;

async function toBitmap(file) {
	if (typeof createImageBitmap === "function") {
		try {
			return await createImageBitmap(file);
		} catch {
			/* HEIC 등 디코딩 실패 시 아래 경로로 */
		}
	}

	const url = URL.createObjectURL(file);
	try {
		const image = new Image();
		await new Promise((resolve, reject) => {
			image.onload = resolve;
			image.onerror = () => reject(new Error("이미지를 읽을 수 없습니다."));
			image.src = url;
		});
		return image;
	} finally {
		URL.revokeObjectURL(url);
	}
}

/**
 * 긴 변을 MAX_EDGE 로 맞춘 JPEG Blob 을 돌려준다.
 * 줄일 필요가 없거나 브라우저가 디코딩하지 못하면 원본 파일을 그대로 돌려준다.
 */
export async function shrinkImage(file) {
	let source;
	try {
		source = await toBitmap(file);
	} catch {
		return file;
	}

	const width = source.width;
	const height = source.height;
	const longest = Math.max(width, height);
	if (!longest) return file;

	const scale = Math.min(1, MAX_EDGE / longest);
	// 이미 규격 안에 들어오는 JPEG 이면 다시 인코딩해서 화질만 깎을 이유가 없다.
	if (scale === 1 && file.type === "image/jpeg") return file;

	const canvas = document.createElement("canvas");
	canvas.width = Math.round(width * scale);
	canvas.height = Math.round(height * scale);
	canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);

	const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
	if (!blob) return file;

	return new File([blob], "cover.jpg", { type: "image/jpeg" });
}
