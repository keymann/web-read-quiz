import { get, post } from "../api.js";
import { navigate } from "../router.js";
import { logout, requireSession } from "../session.js";
import { banner, el, header, mount, setKidMode } from "../ui.js";

/** 아이 홈. 부모가 내준 퀴즈가 여기 도착하고, 여기서 풀기 시작한다(§15). */
export async function childHomePage() {
	setKidMode(true);
	const s = await requireSession("CHILD");
	if (!s) return;

	let quizzes = [];
	let attempts = [];
	let message = null;
	let busy = false;

	await load();

	async function load() {
		try {
			[{ quizzes }, { attempts }] = await Promise.all([
				get("/api/my/quizzes"),
				get("/api/my/attempts"),
			]);
		} catch (err) {
			message = err.message;
		}
		render();
	}

	function render() {
		mount(
			...[
				header(`${s.displayName} 안녕!`, [
					el("button", { class: "btn btn--ghost", text: "로그아웃", onClick: logout }),
				]),
				message ? banner(message) : null,
				inboxCard(),
				attempts.length > 0 ? historyCard() : null,
			].filter(Boolean),
		);
	}

	function inboxCard() {
		return el("section", { class: "card" }, [
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
								el("button", {
									class: "btn",
									type: "button",
									text: quiz.status === "IN_PROGRESS" ? "이어서 풀기" : "풀기 시작",
									disabled: busy,
									onClick: () => startQuiz(quiz.assignmentId),
								}),
							]),
						),
					),
		]);
	}

	function historyCard() {
		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: "지난 기록" }),
			el(
				"ul",
				{ class: "list" },
				attempts.map((a) =>
					el("li", { class: "list__item" }, [
						el("div", { class: "list__main" }, [
							el("span", { class: "list__title", text: a.bookTitle }),
							el("span", {
								class: "list__meta",
								text: `${a.round}회차 · ${a.total}문제 중 ${a.correctCount}개 정답`,
							}),
						]),
						a.completedAt
							? el("a", {
									class: a.passed ? "tag tag--ok" : "tag tag--warn",
									href: `/child/results/${a.id}`,
									"data-link": true,
									text: a.passed ? `통과 · ${a.score}점` : `다시 도전 · ${a.score}점`,
								})
							: el("span", { class: "tag", text: "푸는 중" }),
					]),
				),
			),
		]);
	}

	async function startQuiz(assignmentId) {
		if (busy) return;
		busy = true;
		render();

		try {
			const { attempt } = await post("/api/attempts", { assignmentId });
			return navigate(`/child/quizzes/${attempt.id}`);
		} catch (err) {
			message = err.message;
		}

		busy = false;
		render();
	}
}
