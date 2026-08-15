import { get } from "../api.js";
import { requireSession } from "../session.js";
import { banner, el, header, mount, setKidMode } from "../ui.js";

/**
 * 아이의 결과 화면(§17).
 *
 * 통과했으면 축하하고, 못 했으면 다시 도전할 수 있다고 알려준다. **틀렸다고 나무라지 않는다** —
 * 이 앱의 목적은 점수를 매기는 것이 아니라 책을 읽게 하는 것이다.
 *
 * 재도전(§18 쿨다운·새 문제)은 다음 단계에서 붙는다.
 */
export async function quizResultPage({ id }) {
	setKidMode(true);
	const s = await requireSession("CHILD");
	if (!s) return;

	let attempt = null;
	let message = null;

	try {
		({ attempt } = await get(`/api/attempts/${id}`));
	} catch (err) {
		message = err.message;
	}

	if (!attempt) {
		mount(header("결과", [homeLink()]), banner(message ?? "결과를 불러오지 못했어요."));
		return;
	}

	mount(
		header(attempt.bookTitle, [homeLink()]),
		scoreCard(),
		reviewCard(),
	);

	function homeLink() {
		return el("a", { class: "btn btn--ghost", href: "/child", "data-link": true, text: "← 홈" });
	}

	function scoreCard() {
		const passed = attempt.passed;

		return el("section", { class: "card kid-score" }, [
			el("p", { class: "kid-score__emoji", text: passed ? "🎉" : "📖" }),
			el("h2", {
				class: "kid-score__title",
				text: passed ? "통과했어요!" : "조금만 더!",
			}),
			el("p", { class: "kid-score__number", text: `${attempt.score}점` }),
			el("p", {
				class: passed ? "status status--ok" : "status status--warn",
				text: `${attempt.total}문제 중 ${attempt.correctCount}개를 맞혔어요. (${attempt.passCount}개 맞히면 통과)`,
			}),
			el("p", {
				class: "hint",
				text: passed
					? "책을 꼼꼼히 읽었네요. 다음 책도 기대할게요!"
					: "책을 한 번 더 읽고 다시 도전해 봐요. 새로운 문제로 만나요.",
			}),
		]);
	}

	/** 푼 문제를 되짚어 본다. 안 푼 문제(조기 종료로 남은 것)는 보여주지 않는다. */
	function reviewCard() {
		const solved = attempt.questions.filter((q) => q.selectedChoice !== null);
		if (solved.length === 0) return el("section", { class: "card" }, []);

		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: "다시 보기" }),
			el(
				"ol",
				{ class: "questions" },
				solved.map((question) =>
					el("li", { class: "question" }, [
						el("p", { class: "question__text", text: question.questionText }),
						el(
							"ol",
							{ class: "question__choices" },
							question.choices.map((choice, index) =>
								el("li", {
									class: index + 1 === question.correctChoice ? "is-answer" : "",
									text:
										index + 1 === question.selectedChoice
											? `${choice}  ← 내가 고른 답`
											: choice,
								}),
							),
						),
						el("p", {
							class: question.isCorrect ? "status status--ok" : "status status--warn",
							text: question.isCorrect ? "맞았어요" : "아쉬워요",
						}),
						question.explanation
							? el("p", { class: "question__note", text: question.explanation })
							: null,
					]),
				),
			),
		]);
	}
}
