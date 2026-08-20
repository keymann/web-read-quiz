import { get } from "../api.js";
import { requireSession } from "../session.js";
import { banner, el, header, mount, setKidMode } from "../ui.js";

/** 등록한 책 목록. 각 책의 준비 상태(분석·검색 완료 여부)를 한눈에 보여준다. */
export async function bookListPage() {
	setKidMode(false);
	const s = await requireSession("PARENT");
	if (!s) return;

	let books = [];
	let message = null;
	try {
		({ books } = await get("/api/books"));
	} catch (err) {
		message = err.message;
	}

	mount(
		...[
			header("내 책장", [
				el("a", { class: "btn", href: "/parent/books/new", "data-link": true, text: "+ 책 등록" }),
				el("a", { class: "btn btn--ghost", href: "/parent", "data-link": true, text: "← 홈" }),
			]),
			message ? banner(message) : null,
			el("section", { class: "card" }, [
				books.length === 0
					? el("div", { class: "empty" }, [
							el("p", { text: "아직 등록한 책이 없어요." }),
							el("a", { class: "btn", href: "/parent/books/new", "data-link": true, text: "표지 찍어서 등록하기" }),
						])
					: el(
							"ul",
							// 썸네일이 붙는 목록이라 라벨 정렬을 따로 잡는다(styles.css 의 `.list--books`).
							{ class: "list list--books" },
							books.map((book) =>
								el("li", { class: "list__item" }, [
									el("img", { class: "book-thumb", src: book.coverUrl, alt: "" }),
									el("div", { class: "list__main" }, [
										el("span", { class: "list__title", text: book.title }),
										el("span", {
											class: "list__meta",
											text: [book.author, book.publisher].filter(Boolean).join(" · ") || "정보 없음",
										}),
										el("span", { class: "list__meta", text: stateLabel(book) }),
									]),
									el("a", {
										class: "btn btn--secondary",
										href: `/parent/books/${book.id}`,
										"data-link": true,
										text: "열기",
									}),
								]),
							),
						),
			]),
		].filter(Boolean),
	);
}

const stateLabel = (book) =>
	book.hasBrief ? "✅ 문제 생성 준비 완료" : book.analyzedAt ? "⏳ 책 정보 찾기 남음" : "⏳ 표지 분석 남음";
