import { get, post } from "../api.js";
import { navigate } from "../router.js";
import { requireSession } from "../session.js";
import { banner, el, header, mount, setKidMode } from "../ui.js";

/**
 * 아이가 문제를 푸는 화면(§15).
 *
 * 한 화면에 한 문제. 답을 고르면 **그 자리에서** 맞았는지 알려주고 해설을 보여준 뒤
 * 다음 문제로 넘어간다. 이미 답한 문제로 되돌아가 볼 수는 있지만 다시 답할 수는 없다.
 *
 * 채점은 전부 서버가 한다. 아직 안 푼 문항에는 정답이 실려 오지도 않는다.
 */
export async function quizPlayPage({ id }) {
	setKidMode(true);
	const s = await requireSession("CHILD");
	if (!s) return;

	let attempt = null;
	let message = null;
	/** 지금 보고 있는 문항 번호. 되돌아가 보기 위해 화면 상태로 둔다. */
	let showing = null;
	/** 방금 답한 결과. 다음 문제로 넘어가면 지운다. */
	let feedback = null;
	let busy = false;

	await load();

	async function load() {
		try {
			({ attempt } = await get(`/api/attempts/${id}`));
			// 다 풀었으면 결과 화면이 할 일이다.
			if (attempt.completedAt) return navigate(`/child/results/${id}`, { replace: true });
			showing ??= attempt.nextNumber ?? 1;
		} catch (err) {
			message = err.message;
		}
		render();
	}

	function current() {
		return attempt?.questions.find((q) => q.questionNumber === showing) ?? null;
	}

	function render() {
		if (!attempt) {
			mount(header("퀴즈", [homeLink()]), banner(message ?? "퀴즈를 불러오지 못했어요."));
			return;
		}

		const question = current();
		mount(
			...[
				header(attempt.bookTitle, [homeLink()]),
				message ? banner(message) : null,
				progressCard(),
				question ? questionCard(question) : null,
				navCard(),
			].filter(Boolean),
		);
	}

	function homeLink() {
		return el("a", { class: "btn btn--ghost", href: "/child", "data-link": true, text: "← 홈" });
	}

	function progressCard() {
		return el("section", { class: "card" }, [
			el("p", { class: "kid-progress", text: `${showing} / ${attempt.total}` }),
			el("progress", { class: "progress", value: attempt.answered, max: attempt.total }),
			el("p", {
				class: "hint",
				text: `${attempt.passCount}개를 맞히면 통과예요. 지금까지 ${attempt.correctCount}개 맞혔어요.`,
			}),
		]);
	}

	function questionCard(question) {
		const answered = question.selectedChoice !== null;

		return el("section", { class: "card" }, [
			el("h2", { class: "kid-question", text: question.questionText }),
			el(
				"div",
				{ class: "choices" },
				question.choices.map((choice, index) => choiceButton(question, choice, index + 1, answered)),
			),
			answered ? resultBlock(question) : null,
		]);
	}

	function choiceButton(question, choice, number, answered) {
		// 답한 뒤에는 정답과 내가 고른 답을 색으로 구분한다. 아직이면 평범한 버튼이다.
		const isCorrect = answered && number === question.correctChoice;
		const isPicked = number === question.selectedChoice;
		const wrongPick = answered && isPicked && !isCorrect;

		return el("button", {
			class: `choice${isCorrect ? " choice--correct" : ""}${wrongPick ? " choice--wrong" : ""}`,
			type: "button",
			"aria-pressed": isPicked,
			disabled: answered || busy,
			text: `${number}. ${choice}`,
			onClick: () => submitAnswer(question.questionNumber, number),
		});
	}

	function resultBlock(question) {
		const correct = question.isCorrect;
		return el("div", { class: "kid-result" }, [
			el("p", {
				class: correct ? "status status--ok" : "status status--warn",
				text: correct ? "맞았어요!" : `아쉬워요. 정답은 ${question.correctChoice}번이에요.`,
			}),
			question.explanation ? el("p", { class: "hint", text: question.explanation }) : null,
		]);
	}

	function navCard() {
		const question = current();
		const answered = question?.selectedChoice !== null;
		const last = showing >= attempt.total;

		return el("section", { class: "card" }, [
			el("div", { class: "row" }, [
				showing > 1
					? el("button", {
							class: "btn btn--ghost",
							type: "button",
							text: "← 이전 문제",
							onClick: () => {
								showing -= 1;
								feedback = null;
								render();
							},
						})
					: null,
				answered && !last
					? el("button", {
							class: "btn",
							type: "button",
							text: "다음 문제 →",
							onClick: () => {
								showing += 1;
								feedback = null;
								render();
							},
						})
					: null,
				// 다 못 풀어도 그만둘 수 있어야 한다. 안 그러면 배정이 영영 "푸는 중" 으로 남는다.
				el("button", {
					class: "btn btn--secondary",
					type: "button",
					text: "그만 풀기",
					disabled: busy,
					onClick: quit,
				}),
			]),
		]);
	}

	async function submitAnswer(questionNumber, selectedChoice) {
		if (busy) return;
		busy = true;
		render();

		try {
			const result = await post(`/api/attempts/${id}/answers`, { questionNumber, selectedChoice });
			attempt = result.attempt;
			feedback = result;

			// 통과 기준을 채웠거나 마지막 문제였으면 서버가 판을 끝낸다(§15 조기 종료).
			if (result.finished) return navigate(`/child/results/${id}`);
		} catch (err) {
			message = err.message;
		}

		busy = false;
		render();
	}

	async function quit() {
		if (!window.confirm("지금까지 푼 것으로 끝낼까요?")) return;
		busy = true;
		try {
			await post(`/api/attempts/${id}/submit`);
			return navigate(`/child/results/${id}`);
		} catch (err) {
			message = err.message;
		}
		busy = false;
		render();
	}
}
