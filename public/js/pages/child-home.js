import { get } from "../api.js";
import { logout, requireSession } from "../session.js";
import { banner, el, header, mount, setKidMode } from "../ui.js";

/** 아이 홈. 부모가 내준 퀴즈가 여기 도착한다. 푸는 화면은 다음 단계에서 붙는다. */
export async function childHomePage() {
	setKidMode(true);
	const s = await requireSession("CHILD");
	if (!s) return;

	let quizzes = [];
	let message = null;

	try {
		({ quizzes } = await get("/api/my/quizzes"));
	} catch (err) {
		message = err.message;
	}

	mount(
		...[
			header(`${s.displayName} 안녕!`, [
				el("button", { class: "btn btn--ghost", text: "로그아웃", onClick: logout }),
			]),
			message ? banner(message) : null,
			el("section", { class: "card" }, [
				el("h2", { class: "section-title", text: "오늘의 독서 퀴즈" }),
				quizzes.length === 0
					? el("div", { class: "empty" }, [el("p", { text: "아직 받은 퀴즈가 없어요." })])
					: el(
							"ul",
							{ class: "list" },
							quizzes.map((quiz) =>
								el("li", { class: "list__item" }, [
									el("div", { class: "list__main" }, [
										el("span", { class: "list__title", text: quiz.bookTitle }),
										el("span", {
											class: "list__meta",
											text: `${quiz.questionCount}문제 · ${quiz.passCount}개 맞히면 통과`,
										}),
									]),
									el("span", {
										class: "tag",
										text: quiz.status === "IN_PROGRESS" ? "풀고 있어요" : "새 퀴즈",
									}),
								]),
							),
						),
				quizzes.length > 0
					? el("p", { class: "hint", text: "곧 여기서 바로 풀 수 있어요." })
					: null,
			]),
		].filter(Boolean),
	);
}
