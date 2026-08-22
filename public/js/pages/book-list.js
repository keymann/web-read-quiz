import { del, get } from "../api.js";
import { requireSession } from "../session.js";
import { banner, confirmDialog, el, header, mount, setKidMode } from "../ui.js";

/** 등록한 책 목록. 각 책의 준비 상태(분석·검색 완료 여부)를 한눈에 보여준다. */
export async function bookListPage() {
	setKidMode(false);
	const s = await requireSession("PARENT");
	if (!s) return;

	let books = [];
	let message = null;
	let messageKind = "error";
	/** 지금 지우고 있는 책 id. 그 사이 다른 버튼을 못 누르게 한다. */
	let removing = null;

	// 화면을 떠난 뒤에 응답이 돌아오면 남의 화면을 덮어쓴다. 경로가 바뀌면 그리지 않는다.
	const myPath = location.pathname;

	await reload();

	async function reload() {
		try {
			({ books } = await get("/api/books"));
		} catch (err) {
			message = err.message;
			messageKind = "error";
		}
		render();
	}

	function render() {
		if (location.pathname !== myPath) return;

		mount(
			...[
				header("내 책장", [
					el("a", { class: "btn", href: "/parent/books/new", "data-link": true, text: "+ 책 등록" }),
					el("a", { class: "btn btn--ghost", href: "/parent", "data-link": true, text: "← 홈" }),
				]),
				message ? banner(message, messageKind) : null,
				el("section", { class: "card" }, [
					books.length === 0
						? el("div", { class: "empty" }, [
								el("p", { text: "아직 등록한 책이 없어요." }),
								el("a", {
									class: "btn",
									href: "/parent/books/new",
									"data-link": true,
									text: "표지 찍어서 등록하기",
								}),
							])
						: el(
								"ul",
								// 썸네일이 붙는 목록이라 라벨 정렬을 따로 잡는다(styles.css 의 `.list--books`).
								{ class: "list list--books" },
								books.map(bookItem),
							),
				]),
			].filter(Boolean),
		);
	}

	function bookItem(book) {
		return el("li", { class: "list__item" }, [
			el("img", { class: "book-thumb", src: book.coverUrl, alt: "" }),
			el("div", { class: "list__main" }, [
				el("span", { class: "list__title", text: book.title }),
				el("span", {
					class: "list__meta",
					text: [book.author, book.publisher].filter(Boolean).join(" · ") || "정보 없음",
				}),
				el("span", { class: "list__meta", text: stateLabel(book) }),
			]),
			el("div", { class: "row row--tight" }, [
				el("a", {
					class: "btn btn--secondary",
					href: `/parent/books/${book.id}`,
					"data-link": true,
					text: "열기",
				}),
				el("button", {
					class: "btn btn--danger",
					type: "button",
					text: removing === book.id ? "삭제 중…" : "삭제",
					disabled: removing !== null,
					"aria-label": `${book.title} 삭제`,
					onClick: () => remove(book),
				}),
			]),
		]);
	}

	/**
	 * 책을 지운다. **되돌릴 수 없으므로 무엇이 함께 사라지는지 먼저 알린다.**
	 *
	 * `window.confirm` 을 쓰지 않는 이유: "확인/취소" 로는 어느 쪽이 삭제인지 알 수 없다.
	 * 두 버튼에 각각 이름을 준다(§ui.confirmDialog).
	 */
	async function remove(book) {
		/*
		 * 확인 창을 띄우기 **전에** 표시를 세운다.
		 *
		 * 화면은 창이 뜨기 전 상태로 그려져 있어 다른 줄의 삭제 버튼이 그대로 눌린다. 막지
		 * 않으면 창이 겹쳐 뜨고 두 권이 함께 지워진다. 화면은 아직 다시 그리지 않는다 —
		 * 물어보는 중에 "삭제 중" 이라고 적으면 안 된다.
		 */
		if (removing !== null) return;
		removing = book.id;

		/*
		 * 제목에 조사를 붙이지 않는다. 책 제목은 한국어일 수도 영어일 수도 있어
		 * "을/를" 을 옳게 고를 수 없다. 제목은 이름표로 두고 본문에서 무엇이 사라지는지 적는다.
		 */
		const yes = await confirmDialog({
			title: `‘${book.title}’ 삭제`,
			message:
				"이 책의 정보와 참고 자료, 만들어 둔 문제와 아이의 도전 기록을 모두 삭제합니다. 되돌릴 수 없습니다.",
			confirmText: "삭제",
			cancelText: "취소",
		});
		if (!yes) {
			removing = null;
			return;
		}

		render();

		try {
			await del(`/api/books/${book.id}`);
			message = `‘${book.title}’ 삭제했습니다.`;
			messageKind = "info";
		} catch (err) {
			message = err.message;
			messageKind = "error";
		}
		removing = null;
		await reload();
	}
}

const stateLabel = (book) =>
	book.hasBrief ? "✅ 문제 생성 준비 완료" : book.analyzedAt ? "⏳ 책 정보 찾기 남음" : "⏳ 표지 분석 남음";
