import { get, post } from "../api.js";
import { navigate } from "../router.js";
import { requireSession } from "../session.js";
import { banner, el, header, mount, setKidMode } from "../ui.js";

/** 남은 시간을 아이가 읽을 수 있게. 초 단위까지 보여야 흐르는 게 보인다. */
function waitText(seconds) {
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return m > 0 ? `${m}분 ${String(s).padStart(2, "0")}초` : `${s}초`;
}

/**
 * 아이의 결과 화면(§17·§18).
 *
 * 통과했으면 축하하고, 못 했으면 다시 도전할 수 있다고 알려준다. **틀렸다고 나무라지 않는다** —
 * 이 앱의 목적은 점수를 매기는 것이 아니라 책을 읽게 하는 것이다.
 *
 * 재도전은 20분 뒤부터, **새 문제로** 한다. 같은 문제를 다시 주면 답을 외워서 통과할 수 있어
 * "책을 읽었는지 확인한다" 는 목적이 무너진다. 남은 시간은 서버가 계산해 내려주고 화면은
 * 1초마다 줄여 보여줄 뿐이다 — 기기 시계를 돌려도 소용없다.
 */
export async function quizResultPage({ id }) {
	setKidMode(true);
	const s = await requireSession("CHILD");
	if (!s) return;

	let attempt = null;
	let retry = null;
	let message = null;
	let busy = false;
	let ticker = null;
	const myPath = location.pathname;

	await load();

	async function load() {
		try {
			({ attempt, retry } = await get(`/api/attempts/${id}`));
		} catch (err) {
			message = err.message;
		}
		render();
		schedule();
	}

	/**
	 * 대기 중에는 1초마다, 문제를 만드는 중에는 3초마다 다시 그린다.
	 * 카운트다운이 0 이 되면 서버에 다시 물어 상태를 갱신한다.
	 */
	function schedule() {
		if (ticker !== null) clearInterval(ticker);
		ticker = null;
		if (location.pathname !== myPath) return;

		if (retry?.status === "COOLDOWN" && retry.waitSeconds > 0) {
			ticker = setInterval(() => {
				if (location.pathname !== myPath) return clearInterval(ticker);
				retry.waitSeconds -= 1;
				if (retry.waitSeconds <= 0) return load();
				render();
			}, 1000);
		} else if (retry?.status === "PREPARING") {
			ticker = setInterval(() => {
				if (location.pathname !== myPath) return clearInterval(ticker);
				load();
			}, 3000);
		}
	}

	function render() {
		if (!attempt) {
			mount(header("결과", [homeLink()]), banner(message ?? "결과를 불러오지 못했어요."));
			return;
		}

		mount(
			...[
				header(attempt.bookTitle, [homeLink()]),
				message ? banner(message) : null,
				scoreCard(),
				retryCard(),
				reviewCard(),
			].filter(Boolean),
		);
	}

	function homeLink() {
		return el("a", { class: "btn btn--ghost", href: "/child", "data-link": true, text: "← 홈" });
	}

	/** 재도전 안내. 상태마다 아이가 지금 무엇을 하면 되는지 한 가지만 말해 준다. */
	function retryCard() {
		if (!retry || retry.status === "PASSED") return null;

		switch (retry.status) {
			case "COOLDOWN":
				return el("section", { class: "card" }, [
					el("h2", { class: "section-title", text: "다시 도전하기" }),
					el("p", { class: "kid-countdown", text: waitText(retry.waitSeconds) }),
					el("p", {
						class: "hint",
						text: "그동안 책을 한 번 더 읽어 봐요. 다음에는 새로운 문제가 나와요.",
					}),
				]);

			case "READY":
				return el("section", { class: "card" }, [
					el("h2", { class: "section-title", text: "다시 도전할 수 있어요" }),
					el("p", { class: "hint", text: "새로운 문제로 다시 풀어 봐요." }),
					el("button", {
						class: "btn btn--block",
						type: "button",
						text: busy ? "새 문제를 준비하는 중…" : "새 문제로 다시 도전",
						disabled: busy,
						onClick: startRetry,
					}),
				]);

			case "PREPARING":
				return el("section", { class: "card" }, [
					el("h2", { class: "section-title", text: "새 문제를 만들고 있어요" }),
					el("progress", { class: "progress", value: retry.prepared, max: retry.total || 1 }),
					el("p", { class: "hint", text: `${retry.prepared} / ${retry.total} 문제 · 조금만 기다려요` }),
				]);

			// 부모의 키가 브라우저에서만 동작하는 경우(Gemini). 아이 혼자서는 만들 수 없다.
			case "NEEDS_PARENT":
				return el("section", { class: "card" }, [
					el("h2", { class: "section-title", text: "새 문제를 기다리는 중" }),
					el("p", {
						class: "status status--warn",
						text: "부모님께 새 문제를 만들어 달라고 말해 주세요.",
					}),
				]);

			case "WAITING":
				return el("section", { class: "card" }, [
					el("h2", { class: "section-title", text: "새 문제가 준비됐어요" }),
					el("button", {
						class: "btn btn--block",
						type: "button",
						text: "새 문제 풀러 가기",
						disabled: busy,
						onClick: () => startNext(retry.nextAssignmentId),
					}),
				]);

			default:
				return null;
		}
	}

	async function startRetry() {
		if (busy) return;
		busy = true;
		render();

		try {
			({ retry } = await post(`/api/attempts/${id}/retry`));
		} catch (err) {
			message = err.message;
		}

		busy = false;
		render();
		schedule();
	}

	async function startNext(assignmentId) {
		if (busy) return;
		busy = true;
		render();

		try {
			const { attempt: next } = await post("/api/attempts", { assignmentId });
			if (ticker !== null) clearInterval(ticker);
			return navigate(`/child/quizzes/${next.id}`);
		} catch (err) {
			message = err.message;
		}

		busy = false;
		render();
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
		if (solved.length === 0) return null;

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
