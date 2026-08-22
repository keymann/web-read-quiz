import { get, post } from "../api.js";
import { generateQuestions, usesBrowserRelay } from "../ai-relay.js";
import { requireSession } from "../session.js";
import { navigate } from "../router.js";
import {
	banner,
	confirmAction,
	confirmDialog,
	el,
	header,
	mount,
	selectField,
	setKidMode,
} from "../ui.js";

/**
 * 문제 생성 진행 + 검수 화면(§11·§13).
 *
 * 생성은 백그라운드에서 돌기 때문에 상태를 폴링한다. GENERATING 이면 진행률을,
 * REVIEW 면 문항을 보여준다. 다 만들어지면 아이에게 내보낼 수 있다.
 */

/**
 * 서버 경로의 폴링 간격.
 *
 * 2초 고정이면 다 끝났는데도 최대 2초를 더 기다린다. 생성은 30초를 넘기므로 초반을 촘촘히
 * 하는 것은 요청 몇 번 더 보내는 값이고, 끝나는 순간을 놓치지 않는 이득이 크다.
 * 뒤로 갈수록 늘려 불필요한 요청을 줄인다.
 */
const POLL_START_MS = 600;
const POLL_MAX_MS = 2500;
const POLL_GROWTH = 1.4;
const DIFFICULTY = { 1: "쉬움", 2: "보통", 3: "어려움" };
const LANGUAGE = { en: "영어", ko: "한국어" };
const ASSIGN_STATUS = { ASSIGNED: "아직 안 풀었어요", IN_PROGRESS: "푸는 중", COMPLETED: "다 풀었어요" };
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

/**
 * 진행 단계를 부모의 말로 옮긴다.
 *
 * 생성 한 번이 30초를 넘기는 일이 흔하다. "만드는 중" 한 줄만 띄워 두면 그 시간 내내
 * 멈춘 것처럼 보이고, 실제로 새로고침해서 중단시키는 일이 생긴다. 지금 무엇을 하고
 * 있는지가 계속 바뀌어 보여야 기다릴 수 있다.
 */
function phaseText(p) {
	// 시도 번호는 **1부터 센다.** 서버 경로는 라운드 번호를 보내지 않고(단계 이름만 적는다),
	// 브라우저 경로도 첫 계획을 세우기 전에는 아직 번호가 없다. 그때 번호 자리를 비워 두면
	// 화면에 "undefined번째" 가 뜬다 — 준비 중인 것은 언제나 첫 번째 시도다.
	const round = p.round ?? 1;

	switch (p.phase) {
		case "planning":
			return `${round}번째 시도를 준비하고 있어요`;
		case "generating":
			return p.need
				? `AI 가 문제 ${p.need}개를 만들고 있어요`
				: "AI 가 문제를 만들고 있어요";
		case "screening":
			return "만든 문제가 규칙에 맞는지 검사하고 있어요";
		case "validating":
			return p.checking
				? `AI 가 문제 ${p.checking}개를 검수하고 있어요`
				: "AI 가 문제를 검수하고 있어요";
		case "saving":
			return "검수를 통과한 문제를 저장하고 있어요";
		case "retrying":
			/*
			 * 여기에는 시도 번호를 적지 않는다.
			 *
			 * 두 경로가 이 단계를 **서로 다른 시점에** 알린다. 서버는 다음 라운드를 시작할 때,
			 * 브라우저는 방금 끝난 라운드의 결과로 알린다. 같은 `round` 값이 한쪽에서는 다음
			 * 시도, 다른 쪽에서는 지난 시도를 뜻하므로 번호를 적으면 한쪽이 틀린다.
			 * 번호는 곧 이어지는 `planning` 이 정확하게 알려 준다.
			 */
			return p.dropped
				? `${p.dropped}개가 기준에 못 미쳐 다시 만들어요`
				: "기준에 못 미친 문제를 다시 만들어요";
		case "done":
			return "다 만들었어요";
		case "cancelling":
			return "멈추는 중이에요";
		default:
			// 서버가 아직 단계를 적기 전이거나 모르는 값일 때.
			return "AI 가 문제를 만들고 있어요";
	}
}

export async function quizReviewPage({ id }) {
	setKidMode(false);
	const s = await requireSession("PARENT");
	if (!s) return;

	let message = null;
	let messageKind = "error";
	let timer = null;
	/** 지금 폴링 간격. 매번 조금 늘린다. */
	let pollMs = POLL_START_MS;
	/** 진행 표시를 1초마다 새로 그리는 타이머. 경과 시간이 멈춰 있으면 멈춘 것처럼 보인다. */
	let ticker = null;
	let startedAt = null;
	/** 브라우저가 직접 생성 중일 때의 진행 상황. 서버 폴링과 달리 우리가 직접 안다. */
	let relayProgress = null;
	/**
	 * 부모가 "만들기 취소" 를 눌렀다.
	 *
	 * 릴레이 경로는 이 값을 루프가 단계마다 읽어 스스로 멈춘다. 서버 경로는 서버에 표시를
	 * 남기고 여기서는 화면만 바꾼다.
	 */
	let stopRequested = false;
	/** 다시 만들려고 고른 문항 id. */
	let selected = new Set();
	let children = [];
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
		if (location.pathname !== myPath) return stop();

		let data = null;
		try {
			data = await get(`/api/quizzes/${id}`);
		} catch (err) {
			message = err.message;
			messageKind = "error";
		}
		/*
		 * 이 화면에서 시작하지 않은 생성도 살아 있는 것으로 보여야 한다.
		 *
		 * 예전에는 `startGeneration()` 안에서만 시계를 돌렸다. 그런데 서버 경로는 **책 화면에서**
		 * 생성을 시작하고 이 화면으로 넘어온다 — 그러면 여기서는 아무도 시계를 켜지 않아
		 * 경과 시간이 빈칸이고 1초마다 다시 그리지도 않는다. 화면이 멈춰 보인다.
		 *
		 * 그래서 **진행 중이면 누가 시작했든 여기서 시계를 켠다.**
		 */
		if (data?.quiz.status === "GENERATING") startTicking(data.quiz.startedAt);

		render(data);

		// 브라우저가 직접 돌리는 동안에는 폴링하지 않는다. 진행 상황을 이미 알고 있다.
		if (data?.quiz.status === "GENERATING" && relayProgress === null) {
			timer = setTimeout(refresh, pollMs);
			pollMs = Math.min(POLL_MAX_MS, Math.round(pollMs * POLL_GROWTH));
		} else if (relayProgress === null) {
			stop();
		}
	}

	function stop() {
		if (timer !== null) clearTimeout(timer);
		if (ticker !== null) clearInterval(ticker);
		timer = null;
		ticker = null;
		// 다음 생성은 그때부터 다시 센다. 안 비우면 지난 회차 시각이 남아 몇 분째로 시작한다.
		startedAt = null;
	}

	/**
	 * 진행 중에는 1초마다 다시 그린다. 경과 시간이 흐르는 것만으로도 살아 있다는 신호가 된다.
	 *
	 * @param serverStartedAt 서버가 적어 둔 시작 시각(ISO). 다른 화면에서 시작하고 넘어왔으면
	 *   이 값이 있어야 **실제로 흐른 시간**을 보여줄 수 있다. 없으면 지금부터 센다.
	 */
	function startTicking(serverStartedAt = null) {
		if (startedAt === null) {
			const parsed = serverStartedAt ? Date.parse(serverStartedAt) : Number.NaN;
			startedAt = Number.isNaN(parsed) ? Date.now() : parsed;
		}
		if (ticker !== null) return;

		ticker = setInterval(() => {
			if (location.pathname !== myPath) return stop();
			render(lastData);
		}, 1000);
	}

	function render(data) {
		if (data) lastData = data;
		/*
		 * 이미 다른 화면으로 갔으면 그리지 않는다.
		 *
		 * 취소하고 나가도 **돌고 있던 AI 호출은 끝까지 간다.** 그 호출이 끝나며 진행 상황을
		 * 알려 오는데, 그때 그리면 부모가 방금 이동한 화면을 덮어써 되돌아온 것처럼 보인다.
		 * `refresh()` 는 같은 검사를 이미 하고 있고, 여기는 릴레이 진행 콜백이 들어오는 길이다.
		 */
		if (location.pathname !== myPath) return;
		if (!data) {
			mount(header("퀴즈", [backLink()]), banner(message ?? "퀴즈를 불러오지 못했습니다."));
			return;
		}

		const { quiz, questions, progress, assignments } = data;
		const complete = progress.generated >= progress.total && relayProgress === null;

		mount(
			...[
				header(quiz.bookTitle || "퀴즈", [
					complete ? assignButton() : null,
					backLink(quiz.bookId),
				].filter(Boolean)),
				message ? banner(message, messageKind) : null,
				quiz.error ? banner(quiz.error) : null,
				assignments?.length > 0 ? assignedCard(assignments) : null,
				statusCard(quiz, progress, assignments ?? []),
				questions.length > 0 ? questionsCard(questions, quiz) : null,
			].filter(Boolean),
		);
	}

	/** 지금 문제를 만들고 있는가. 서버 경로든 브라우저 경로든 하나로 본다. */
	function isBusy() {
		return relayProgress !== null || lastData?.quiz.status === "GENERATING";
	}

	// 화살표 함수를 const 로 두면 render() 가 먼저 실행될 때 TDZ 에 걸린다. 선언식으로 둔다.
	function backLink(bookId) {
		const href = bookId ? `/parent/books/${bookId}` : "/parent/books";

		/*
		 * 만드는 중에는 링크가 아니라 버튼이다.
		 *
		 * 링크로 두면 눌리는 순간 화면이 바뀌어 버려 물어볼 틈이 없다. 브라우저 경로에서는
		 * 그것이 곧 생성 중단이라 부모는 왜 문제가 안 만들어졌는지 알 수 없다.
		 */
		if (!isBusy()) {
			return el("a", { class: "btn btn--ghost", href, "data-link": true, text: "← 책으로" });
		}

		return el("button", {
			class: "btn btn--ghost",
			type: "button",
			text: "← 책으로",
			onClick: () => askBeforeLeaving(href),
		});
	}

	/**
	 * 만드는 중에 나가려 할 때 묻는다.
	 *
	 * `window.confirm` 을 쓰지 않는 이유: "확인/취소" 로는 어느 쪽이 "멈추기" 인지 알 수 없다.
	 * 두 버튼에 각각 이름을 준다(§ui.confirmDialog).
	 */
	async function askBeforeLeaving(href) {
		const stopIt = await confirmDialog({
			title: "문제 만드는 중이에요",
			// 제목을 되풀이하지 않고 **나가면 무슨 일이 벌어지는지**를 적는다. 그것을 알아야
			// 두 버튼 중 하나를 고를 수 있다.
			message: "지금 나가면 만들기가 멈춰요. 그때까지 만든 문제는 저장됩니다.",
			confirmText: "만들기 취소",
			cancelText: "기다리기",
		});

		if (!stopIt) return;

		await cancelGeneration();
		navigate(href);
	}

	/**
	 * 만들기를 멈춘다.
	 *
	 * 두 경로가 다르다.
	 *  - 브라우저 경로: 루프가 이 화면에 있으므로 표시만 세우면 다음 단계에서 스스로 멈춘다.
	 *  - 서버 경로: 백그라운드 작업은 밖에서 죽일 수 없어 서버에 표시를 남긴다.
	 *
	 * 멈추는 시점이 다르다. 브라우저 경로는 **돌고 있는 호출을 곧바로 끊는다.** 서버 경로는
	 * 밖에서 끊을 수 없어 지금 돌고 있는 AI 호출이 끝난 뒤에 멈춘다 — 화면을 떠난 뒤에도
	 * 몇 초 동안은 서버가 일하고 있을 수 있다. 어느 쪽이든 그때까지 통과한 문항은 저장된다.
	 */
	async function cancelGeneration() {
		stopRequested = true;
		relayProgress = null;
		stop();

		try {
			await post(`/api/quizzes/${id}/cancel`);
		} catch {
			// 취소를 못 알렸어도 화면은 떠난다. 브라우저 경로는 이미 멈췄고,
			// 서버 경로는 다음 폴링에서 상태가 맞춰진다.
		}
	}

	function elapsedText() {
		if (startedAt === null) return "";
		const seconds = Math.floor((Date.now() - startedAt) / 1000);
		const minutes = Math.floor(seconds / 60);
		return minutes > 0 ? `${minutes}분 ${seconds % 60}초째` : `${seconds}초째`;
	}

	function statusCard(quiz, progress, assignments) {
		if (relayProgress !== null) {
			const done = relayProgress.accepted ?? 0;
			const total = relayProgress.target || progress.total;

			return el("section", { class: "card" }, [
				el("h2", { class: "section-title", text: "문제를 만드는 중이에요" }),
				el("p", { class: "status status--warn", text: `${phaseText(relayProgress)} · ${elapsedText()}` }),
				stopRequested ? el("p", { class: "hint", text: "멈추는 중이에요." }) : null,
				relayProgress.note ? el("p", { class: "hint", text: relayProgress.note }) : null,
				el("progress", { class: "progress", value: done, max: total || 1 }),
				el("p", { class: "hint", text: `${done} / ${total} 문제 저장됨` }),
				el("p", {
					class: "hint",
					text: "이 화면을 닫으면 중간에 멈춥니다. 1~2분 걸릴 수 있어요.",
				}),
			].filter(Boolean));
		}

		if (quiz.status === "GENERATING") {
			const percent = Math.round((progress.generated / progress.total) * 100);
			return el("section", { class: "card" }, [
				el("h2", { class: "section-title", text: "문제를 만드는 중이에요" }),
				el("p", {
					class: "status status--warn",
					// 서버가 적어 둔 단계를 그대로 문장으로 옮긴다. 예전에는 한 줄이 고정이라
					// 30초 내내 같은 글자만 떠 있었고, 그러면 멈춘 것처럼 보인다.
					text: `${phaseText({ phase: quiz.phase })} · ${elapsedText()}`,
				}),
				stopRequested || quiz.cancelRequested
					? el("p", { class: "hint", text: "멈추는 중이에요. 하던 요청이 끝나면 멈춥니다." })
					: null,
				// CSP 가 인라인 style 을 막으므로 폭을 직접 계산해 넣을 수 없다.
				// 네이티브 <progress> 는 값만 주면 되고 접근성도 따라온다.
				el("progress", { class: "progress", value: progress.generated, max: progress.total }),
				el("p", { class: "hint", text: `${progress.generated} / ${progress.total} 문제 (${percent}%)` }),
				el("p", { class: "hint", text: "1~2분 걸릴 수 있어요. 이 화면을 열어 두세요." }),
			].filter(Boolean));
		}

		const complete = progress.generated >= progress.total;
		const sent = assignments.length > 0;

		return el("section", { class: "card" }, [
			el("h2", {
				class: "section-title",
				text: `${quiz.round}회차 · ${LANGUAGE[quiz.language] ?? quiz.language} · 문제 ${progress.generated}개`,
			}),
			el("p", {
				class: complete ? "status status--ok" : "status status--warn",
				text: !complete
					? `아직 ${progress.total - progress.generated}문제가 부족합니다.`
					: sent
						? `${progress.total}문제를 아이에게 내줬습니다. 다른 아이에게도 낼 수 있어요.`
						: `${progress.total}문제가 준비되었습니다. 내용을 확인한 뒤 아이에게 내주세요.`,
			}),
			el("div", { class: "row" }, [
				el("button", {
					class: "btn",
					type: "button",
					text: progress.generated === 0 ? "문제 만들기" : "부족한 문제 채우기",
					disabled: complete,
					onClick: startGeneration,
				}),
			]),
		]);
	}

	/* ── 아이에게 내주기 ─────────────────────────────── */

	function assignButton() {
		return el("button", {
			class: "btn",
			type: "button",
			text: "아이에게 내주기",
			onClick: openAssign,
		});
	}

	function assignedCard(assignments) {
		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: "내준 아이" }),
			el(
				"ul",
				{ class: "list" },
				assignments.map((a) =>
					el("li", { class: "list__item" }, [
						el("div", { class: "list__main" }, [
							el("span", { class: "list__title", text: a.childName }),
							el("span", { class: "list__meta", text: a.assignedAt.slice(0, 10) }),
						]),
						el("span", { class: "tag", text: ASSIGN_STATUS[a.status] ?? a.status }),
					]),
				),
			),
		]);
	}

	/** 아이를 고르는 작은 폼. 아이가 하나뿐이면 곧바로 확인만 받는다. */
	async function openAssign() {
		try {
			if (children.length === 0) ({ children } = await get("/api/children"));
		} catch (err) {
			message = err.message;
			messageKind = "error";
			return refresh();
		}

		if (children.length === 0) {
			message = "먼저 아이를 등록해 주세요. 설정 → 아이 관리에서 추가할 수 있습니다.";
			messageKind = "error";
			return refresh();
		}

		if (children.length === 1) {
			if (!confirmAction(`${children[0].name} 에게 이 퀴즈를 내줄까요?`)) return;
			return assignTo(children[0].id);
		}

		const picker = selectField(
			"어느 아이에게 낼까요?",
			children.map((c) => ({
				value: c.id,
				label: c.grade ? `${c.name} (${c.grade}학년)` : c.name,
			})),
			children[0].id,
		);

		const form = el("form", { class: "card" }, [
			el("h2", { class: "section-title", text: "아이에게 내주기" }),
			picker.wrap,
			el("div", { class: "row" }, [
				el("button", { class: "btn", type: "submit", text: "내주기" }),
				el("button", { class: "btn btn--ghost", type: "button", text: "취소", onClick: () => refresh() }),
			]),
		]);

		form.addEventListener("submit", (event) => {
			event.preventDefault();
			assignTo(picker.select.value);
		});

		mount(header(lastData.quiz.bookTitle || "퀴즈", [backLink(lastData.quiz.bookId)]), form);
	}

	async function assignTo(childId) {
		try {
			const { assignment } = await post(`/api/quizzes/${id}/assign`, { childId });
			message = `${assignment.childName} 에게 퀴즈를 내줬어요.`;
			messageKind = "info";
		} catch (err) {
			message = err.message;
			messageKind = "error";
		}
		await refresh();
	}

	/* ── 검수 ────────────────────────────────────────── */

	function questionsCard(questions, quiz) {
		const editable = ["DRAFT", "REVIEW"].includes(quiz.status);

		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: "문제 검수" }),
			el("p", {
				class: "hint",
				text: editable
					? "마음에 들지 않는 문제를 고르면 그 문제만 다시 만듭니다."
					: "이미 내준 퀴즈는 고칠 수 없습니다.",
			}),
			editable
				? el("div", { class: "row" }, [
						el("button", {
							class: "btn btn--secondary",
							type: "button",
							text: selected.size > 0 ? `${selected.size}개 다시 만들기` : "다시 만들 문제를 고르세요",
							disabled: selected.size === 0,
							onClick: regenerateSelected,
						}),
						selected.size > 0
							? el("button", {
									class: "btn btn--ghost",
									type: "button",
									text: "선택 해제",
									onClick: () => {
										selected.clear();
										render(lastData);
									},
								})
							: null,
					].filter(Boolean))
				: null,
			el("ol", { class: "questions" }, questions.map((q) => questionItem(q, editable))),
		]);
	}

	function questionItem(question, editable) {
		const checkbox = editable
			? el("input", {
					class: "question__pick",
					type: "checkbox",
					checked: selected.has(question.id),
					"aria-label": `${question.questionNumber}번 문제 다시 만들기`,
					onChange: (event) => {
						if (event.target.checked) selected.add(question.id);
						else selected.delete(question.id);
						render(lastData);
					},
				})
			: null;

		return el("li", { class: selected.has(question.id) ? "question is-picked" : "question" }, [
			el("div", { class: "question__head" }, [
				checkbox,
				el("p", { class: "question__text", text: question.questionText }),
			]),
			el(
				"ol",
				{ class: "question__choices" },
				question.choices.map((choice, index) =>
					el("li", { class: index + 1 === question.correctChoice ? "is-answer" : "", text: choice }),
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

	/**
	 * 고른 문항을 치우고 그 자리를 다시 채운다.
	 *
	 * 치우는 것과 채우는 것을 나눈 이유: 채우는 경로가 서버(백그라운드)와 브라우저 릴레이로
	 * 갈라져 있다. 서버가 지우면서 생성까지 시작해 버리면 릴레이 쪽은 막힌 경로로 나간다.
	 */
	async function regenerateSelected() {
		const count = selected.size;
		if (count === 0) return;
		if (!confirmAction(`${count}개 문제를 지우고 다시 만들까요?`)) return;

		try {
			await post(`/api/quizzes/${id}/regenerate`, { questionIds: [...selected] });
			selected.clear();
		} catch (err) {
			message = err.message;
			messageKind = "error";
			return refresh();
		}

		await startGeneration();
	}

	async function startGeneration() {
		message = null;
		messageKind = "info";
		// 지난 회차에서 취소했더라도 새로 누른 것은 새로 시작한다.
		stopRequested = false;

		try {
			if (await usesBrowserRelay()) {
				// 브라우저가 Gemini 를 직접 부른다. 서버는 각 라운드에서 무엇을 부를지 정하고
				// 결과를 판정한다. 탭을 닫으면 중간에 멈추므로 진행 상황을 계속 보여 준다.
				// 시도 번호를 처음부터 채워 둔다. 비워 두면 첫 화면이 번호 없이 뜨고,
				// 곧 도착하는 첫 보고와 문장이 달라 보인다.
				relayProgress = { phase: "planning", round: 1, accepted: 0, target: 0 };
				startTicking();
				await refresh();

				const result = await generateQuestions(
					id,
					(progress) => {
						relayProgress = progress;
						render(lastData);
					},
					() => stopRequested,
				);

				relayProgress = null;
				stop();

				if (result.cancelled) {
					// 화면을 떠나는 중일 수도 있다. 그 경우 이 문구는 보이지 않지만,
					// 머물러 있기로 한 경우에는 무슨 일이 있었는지 알아야 한다.
					message = "문제 만들기를 멈췄습니다. 그때까지 만든 문제는 저장했습니다.";
					messageKind = "info";
				} else {
					message = result.done
						? "문제가 준비되었습니다."
						: `${result.target}문제 중 ${result.accepted}개만 검수를 통과했습니다. 다시 만들면 나머지를 채웁니다.`;
					messageKind = result.done ? "info" : "error";
				}
			} else {
				await post(`/api/quizzes/${id}/generate`);
				// 새 생성이 시작되면 간격도 처음부터. 앞 회차에서 늘어난 값을 물려받으면
				// 시작 직후 몇 초를 그냥 기다린다.
				pollMs = POLL_START_MS;
				startTicking();
				message = "문제 만들기를 시작했습니다.";
			}
		} catch (err) {
			relayProgress = null;
			stop();
			message = err.message;
			messageKind = "error";
		}

		await refresh();
	}
}
