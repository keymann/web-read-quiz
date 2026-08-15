import { logout, requireSession } from "../session.js";
import { el, header, mount, setKidMode } from "../ui.js";

/** 아이 홈. Phase 6 에서 제출된 퀴즈 목록이 여기에 들어온다. */
export async function childHomePage() {
	setKidMode(true);
	const s = await requireSession("CHILD");
	if (!s) return;

	mount(
		header(`${s.displayName} 안녕!`, [
			el("button", { class: "btn btn--ghost", text: "로그아웃", onClick: logout }),
		]),
		el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: "오늘의 독서 퀴즈" }),
			el("div", { class: "empty" }, [el("p", { text: "아직 받은 퀴즈가 없어요." })]),
		]),
	);
}
