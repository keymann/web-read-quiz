import { get } from "../api.js";
import { logout, requireSession } from "../session.js";
import { banner, el, header, mount, setKidMode } from "../ui.js";

/** 부모 홈 — 아이 목록과 다음 행동 진입점. Phase 3 부터 책 등록 카드가 여기에 붙는다. */
export async function parentHomePage() {
	setKidMode(false);
	const s = await requireSession("PARENT");
	if (!s) return;

	let children = [];
	let error = null;
	try {
		({ children } = await get("/api/children"));
	} catch (err) {
		error = err.message;
	}

	mount(
		header(`${s.displayName} 님`, [
			el("a", { class: "btn btn--secondary", href: "/parent/children", "data-link": true, text: "아이 관리" }),
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
			el("p", {
				class: "hint",
				text: "책 등록과 AI 문제 생성은 Phase 3·4 에서 열립니다. 먼저 설정 화면에서 OpenAI API Key 를 준비해 주세요.",
			}),
		]),
	);
}
