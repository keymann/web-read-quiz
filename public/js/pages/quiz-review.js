import { get, post } from "../api.js";
import { generateQuestions, usesBrowserRelay } from "../ai-relay.js";
import { requireSession } from "../session.js";
import { banner, el, header, mount, setKidMode } from "../ui.js";

/**
 * 문제 생성 진행 + 검수 화면(§11).
 *
 * 생성은 백그라운드에서 돌기 때문에 상태를 폴링한다. GENERATING 이면 진행률을,
 * REVIEW 면 20문항을 보여준다.
 */

const POLL_MS = 2000;
const DIFFICULTY = { 1: "쉬움", 2: "보통", 3: "어려움" };
const TYPE_LABEL = {
	EVENT: "사건",
	CHARACTER: "등장인물",
	DETAIL: "세부 내용",
	SEQUENCE: "사건 순서",
	CAUSE_EFFECT: "원인과 결과",
	ACTION: "행동",
	EMOTION: "감정",
	INFERENCE: "추론",
};

export async function quizReviewPage({ id }) {
	setKidMode(false);
	const s = await requireSession("PARENT");
	if (!s) return;

	let message = null;
	let messageKind = "error";
	let timer = null;
	/** 브라우저가 직접 생성 중일 때의 진행 상황. 서버 폴링과 달리 우리가 직접 안다. */
	let relayProgress = null;
	/**
	 * 마지막으로 그린 데이터. 진행 표시만 갱신할 때 다시 조회하지 않으려고 들고 있는다.
	 *
	 * 선언은 반드시 첫 `refresh()` 보다 위에 둔다 — 아래에 두면 초기화 전에 읽혀 TDZ 로 터진다.
	 */
	let lastData = null;
	// 화면을 떠난 뒤에도 폴링이 돌면 남의 화면을 덮어쓴다. 경로가 바뀌면 멈춘다.
	const myPath = location.pathname;

	await refresh();

	// 릴레이 모드에서는 서버가 생성을 시작해 주지 않는다(홍콩 콜로에서 나가면 Gemini 에 막힌다).
	// 책 화면에서 막 넘어와 아직 문항이 없다면 여기서 바로 돌린다.
	if (lastData?.quiz.status === "DRAFT" && lastData.progress.generated === 0) {
		if (await usesBrowserRelay()) await startGeneration();
	}

	async function refresh() {
		if (location.pathname !== myPath) return stopPolling();

		let data = null;
		try {
			data = await get(`/api/quizzes/${id}`);
		} catch (err) {
			message = err.message;
			messageKind = "error";
		}
		render(data);

		// 브라우저가 직접 돌리는 동안에는 폴링하지 않는다. 진행 상황을 이미 알고 있다.
		if (data?.quiz.status === "GENERATING" && relayProgress === null) {
			timer = setTimeout(refresh, POLL_MS);
		} else {
			stopPolling();
		}
	}

	function stopPolling() {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	}

	function render(data) {
		if (data) lastData = data;
		if (!data) {
			mount(header("퀴즈", [backLink()]), banner(message ?? "퀴즈를 불러오지 못했습니다."));
			return;
		}

		const { quiz, questions, progress } = data;
		mount(
			...[
				header(quiz.bookTitle || "퀴즈", [backLink(quiz.bookId)]),
				message ? banner(message, messageKind) : null,
				quiz.error ? banner(quiz.error) : null,
				statusCard(quiz, progress),
				questions.length > 0 ? questionsCard(questions) : null,
			].filter(Boolean),
		);
	}

	// 화살표 함수를 const 로 두면 render() 가 먼저 실행될 때 TDZ 에 걸린다. 선언식으로 둔다.
	function backLink(bookId) {
		return el("a", {
			class: "btn btn--ghost",
			href: bookId ? `/parent/books/${bookId}` : "/parent/books",
			"data-link": true,
			text: "← 책으로",
		});
	}

	function statusCard(quiz, progress) {
		if (relayProgress !== null) {
			const done = relayProgress.accepted;
			const total = relayProgress.target || progress.total;
			return el("section", { class: "card" }, [
				el("h2", { class: "section-title", text: "문제를 만드는 중이에요" }),
				el("p", {
					class: "hint",
					text:
						relayProgress.phase === "validating"
							? "만든 문제를 AI 가 검수하고 있습니다. 이 화면을 닫지 마세요."
							: "AI 가 문제를 만들고 있습니다. 1~2분 걸릴 수 있어요. 이 화면을 닫지 마세요.",
				}),
				el("progress", { class: "progress", value: done, max: total }),
				el("p", { class: "status status--warn", text: `${done} / ${total} 문제` }),
			]);
		}

		if (quiz.status === "GENERATING") {
			const percent = Math.round((progress.generated / progress.total) * 100);
			return el("section", { class: "card" }, [
				el("h2", { class: "section-title", text: "문제를 만드는 중이에요" }),
				el("p", {
					class: "hint",
					text: "AI 가 문제를 만들고 스스로 검수하고 있습니다. 1~2분 걸릴 수 있어요. 이 화면을 열어 두세요.",
				}),
				// CSP 가 인라인 style 을 막으므로 폭을 직접 계산해 넣을 수 없다.
				// 네이티브 <progress> 는 값만 주면 되고 접근성도 따라온다.
				el("progress", { class: "progress", value: progress.generated, max: progress.total }),
				el("p", {
					class: "status status--warn",
					text: `${progress.generated} / ${progress.total} 문제 (${percent}%)`,
				}),
			]);
		}

		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: `${quiz.round}회차 · 문제 ${progress.generated}개` }),
			el("p", {
				class: progress.generated === progress.total ? "status status--ok" : "status status--warn",
				text:
					progress.generated === progress.total
						? `${progress.total}문제가 준비되었습니다. 내용을 확인해 주세요.`
						: `아직 ${progress.total - progress.generated}문제가 부족합니다.`,
			}),
			el("div", { class: "row" }, [
				el("button", {
					class: "btn",
					type: "button",
					text: progress.generated === 0 ? "문제 만들기" : "다시 만들기",
					onClick: startGeneration,
				}),
			]),
		]);
	}

	function questionsCard(questions) {
		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: "문제 검수" }),
			el("p", { class: "hint", text: "수정·삭제·재생성은 다음 단계에서 열립니다." }),
			el("ol", { class: "questions" }, questions.map(questionItem)),
		]);
	}

	function questionItem(question) {
		return el("li", { class: "question" }, [
			el("p", { class: "question__text", text: question.questionText }),
			el(
				"ol",
				{ class: "question__choices" },
				question.choices.map((choice, index) =>
					el("li", {
						class: index + 1 === question.correctChoice ? "is-answer" : "",
						text: choice,
					}),
				),
			),
			el("p", { class: "question__meta" }, [
				el("span", { class: "tag", text: TYPE_LABEL[question.questionType] ?? question.questionType }),
				el("span", { class: "tag", text: DIFFICULTY[question.difficulty] ?? "보통" }),
				question.readRequired ? el("span", { class: "tag tag--ok", text: "읽어야 풀 수 있음" }) : null,
			]),
			question.explanation ? el("p", { class: "question__note", text: `해설 · ${question.explanation}` }) : null,
			question.evidence ? el("p", { class: "question__note", text: `근거 · ${question.evidence}` }) : null,
		]);
	}

	async function startGeneration() {
		message = "문제 만들기를 시작했습니다.";
		messageKind = "info";

		try {
			if (await usesBrowserRelay()) {
				// 브라우저가 Gemini 를 직접 부른다. 서버는 각 라운드에서 무엇을 부를지 정하고
				// 결과를 판정한다. 탭을 닫으면 중간에 멈추므로 진행 상황을 계속 보여 준다.
				relayProgress = { accepted: 0, target: 0, phase: "generating" };
				await refresh();

				const result = await generateQuestions(id, (progress) => {
					relayProgress = progress;
					render(lastData);
				});

				relayProgress = null;
				message = result.done
					? "문제가 준비되었습니다."
					: `${result.target}문제 중 ${result.accepted}개만 검수를 통과했습니다. 다시 만들면 나머지를 채웁니다.`;
				messageKind = result.done ? "info" : "error";
			} else {
				await post(`/api/quizzes/${id}/generate`);
			}
		} catch (err) {
			relayProgress = null;
			message = err.message;
			messageKind = "error";
		}

		await refresh();
	}
}
