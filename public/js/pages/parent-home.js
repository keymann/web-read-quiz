import { get } from "../api.js";
import { logout, requireSession } from "../session.js";
import { banner, el, header, mount, setKidMode } from "../ui.js";

/** 부모 홈 — 아이 목록과 다음 행동 진입점. Phase 3 부터 책 등록 카드가 여기에 붙는다. */
export async function parentHomePage() {
	setKidMode(false);
	const s = await requireSession("PARENT");
	if (!s) return;

	let children = [];
	let settings = null;
	let error = null;
	try {
		[{ children }, settings] = await Promise.all([get("/api/children"), get("/api/settings")]);
	} catch (err) {
		error = err.message;
	}

	mount(
		header(`${s.displayName} 님`, [
			el("a", { class: "btn btn--secondary", href: "/parent/books", "data-link": true, text: "내 책장" }),
			el("a", { class: "btn btn--secondary", href: "/parent/children", "data-link": true, text: "아이 관리" }),
			el("a", { class: "btn btn--secondary", href: "/parent/settings", "data-link": true, text: "설정" }),
			el("button", { class: "btn btn--ghost", text: "로그아웃", onClick: logout }),
		]),
		error ? banner(error) : null,
		el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: "내 아이" }),
			children.length === 0
				? el("div", { class: "empty" }, [
						el("p", { text: "아직 등록된 아이가 없어요." }),
						el("a", { class: "btn", href: "/parent/children", "data-link": true, text: "아이 추가하기" }),
					])
				: el(
						"ul",
						{ class: "list" },
						children.map((child) =>
							el("li", { class: "list__item" }, [
								el("div", { class: "list__main" }, [
									el("span", { class: "list__title", text: child.name }),
									el("span", {
										class: "list__meta",
										text: child.grade ? `${child.grade}학년 · ${child.loginId}` : child.loginId ?? "",
									}),
								]),
							]),
						),
					),
		]),
		el("section", { class: "card card--muted" }, [
			el("h2", { class: "section-title", text: "다음 단계" }),
			settings?.ai.configured
				? el("div", { class: "empty" }, [
						el("p", { text: "책 표지를 찍으면 AI 가 책을 알아보고 정보를 모읍니다." }),
						el("a", { class: "btn", href: "/parent/books/new", "data-link": true, text: "책 등록하기" }),
					])
				: el("div", { class: "empty" }, [
						el("p", { text: "문제를 만들려면 먼저 AI API Key 를 등록해야 합니다. Gemini 는 결제 수단 없이 무료로 시작할 수 있어요." }),
						el("a", { class: "btn", href: "/parent/settings", "data-link": true, text: "설정으로 가기" }),
					]),
		]),
	);
}
