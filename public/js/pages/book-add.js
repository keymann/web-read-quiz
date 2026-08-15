import { upload } from "../api.js";
import { shrinkImage } from "../image.js";
import { navigate } from "../router.js";
import { requireSession } from "../session.js";
import { banner, el, header, mount, setKidMode } from "../ui.js";

/**
 * 책 등록 — 표지 촬영 / 갤러리 / 파일 업로드(§5).
 *
 * 카메라는 `capture="environment"` 로 연다. 빌드 없는 환경에서 가장 단순하고
 * 모바일·태블릿·PC 어디서나 같은 코드로 동작한다. PC 에서는 그냥 파일 선택 창이 뜬다.
 */
export async function bookAddPage() {
	setKidMode(false);
	const s = await requireSession("PARENT");
	if (!s) return;

	let message = null;
	let previewUrl = null;
	let selected = null;

	const container = el("div");
	mount(
		header("책 등록", [el("a", { class: "btn btn--ghost", href: "/parent", "data-link": true, text: "← 홈" })]),
		container,
	);
	render();

	function render() {
		const camera = el("input", {
			type: "file",
			accept: "image/*",
			capture: "environment",
			class: "visually-hidden",
			id: "cover-camera",
			onChange: (e) => pick(e.target.files[0]),
		});
		const gallery = el("input", {
			type: "file",
			accept: "image/jpeg,image/png,image/webp,image/heic",
			class: "visually-hidden",
			id: "cover-gallery",
			onChange: (e) => pick(e.target.files[0]),
		});

		const submit = el("button", {
			class: "btn btn--block",
			type: "button",
			text: "이 표지로 등록하기",
			disabled: selected === null,
			onClick: send,
		});

		container.replaceChildren(
			...[
				message ? banner(message) : null,
				el("section", { class: "card" }, [
					el("h2", { class: "section-title", text: "책 표지 사진" }),
					el("p", {
						class: "hint",
						text: "표지 전체가 잘리지 않게, 글씨가 또렷하게 보이도록 찍어 주세요. 뒤표지 바코드가 함께 보이면 더 정확합니다.",
					}),
					camera,
					gallery,
					el("div", { class: "row" }, [
						el("label", { class: "btn", for: "cover-camera", text: "📷 카메라로 찍기" }),
						el("label", { class: "btn btn--secondary", for: "cover-gallery", text: "🖼 사진 고르기" }),
					]),
					previewUrl
						? el("figure", { class: "preview" }, [
								el("img", { class: "preview__img", src: previewUrl, alt: "선택한 표지 미리보기" }),
							])
						: null,
					submit,
				]),
			].filter(Boolean),
		);
	}

	async function pick(file) {
		if (!file) return;
		message = null;
		try {
			selected = await shrinkImage(file);
		} catch (err) {
			message = err.message;
			selected = null;
		}
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewUrl = selected ? URL.createObjectURL(selected) : null;
		render();
	}

	async function send() {
		if (!selected) return;
		message = null;
		const form = new FormData();
		form.append("cover", selected, "cover.jpg");
		try {
			const { book } = await upload("/api/books", form);
			await navigate(`/parent/books/${book.id}`, { replace: true });
		} catch (err) {
			message = err.message;
			render();
		}
	}
}
