import { get, post } from "../api.js";
import { generateQuestions, usesBrowserRelay } from "../ai-relay.js";
import { requireSession } from "../session.js";
import { banner, confirmAction, el, header, mount, selectField, setKidMode } from "../ui.js";

/**
 * 문제 생성 진행 + 검수 화면(§11·§13).
 *
 * 생성은 백그라운드에서 돌기 때문에 상태를 폴링한다. GENERATING 이면 진행률을,
 * REVIEW 면 문항을 보여준다. 다 만들어지면 아이에게 내보낼 수 있다.
 */

const POLL_MS = 2000;
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
	switch (p.phase) {
		case "planning":
			return `${p.round}번째 시도를 준비하고 있어요`;
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
			return p.dropped
				? `${p.dropped}개가 기준에 못 미쳐 다시 만들어요`
				: "기준에 못 미친 문제를 다시 만들어요";
		case "done":
			return "다 만들었어요";
		default:
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
	/** 진행 표시를 1초마다 새로 그리는 타이머. 경과 시간이 멈춰 있으면 멈춘 것처럼 보인다. */
	let ticker = null;
	let startedAt = null;
	/** 브라우저가 직접 생성 중일 때의 진행 상황. 서버 폴링과 달리 우리가 직접 안다. */
	let relayProgress = null;
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
		render(data);

		// 브라우저가 직접 돌리는 동안에는 폴링하지 않는다. 진행 상황을 이미 알고 있다.
		if (data?.quiz.status === "GENERATING" && relayProgress === null) {
			timer = setTimeout(refresh, POLL_MS);
		} else if (relayProgress === null) {
			stop();
		}
	}

	function stop() {
		if (timer !== null) clearTimeout(timer);
		if (ticker !== null) clearInterval(ticker);
		timer = null;
		ticker = null;
	}

	/** 진행 중에는 1초마다 다시 그린다. 경과 시간이 흐르는 것만으로도 살아 있다는 신호가 된다. */
	function startTicking() {
		if (ticker !== null) return;
		startedAt = Date.now();
		ticker = setInterval(() => {
			if (location.pathname !== myPath) return stop();
			render(lastData);
		}, 1000);
	}

	function render(data) {
		if (data) lastData = data;
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

	// 화살표 함수를 const 로 두면 render() 가 먼저 실행될 때 TDZ 에 걸린다. 선언식으로 둔다.
	function backLink(bookId) {
		return el("a", {
			class: "btn btn--ghost",
			href: bookId ? `/parent/books/${bookId}` : "/parent/books",
			"data-link": true,
			text: "← 책으로",
		});
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
				relayProgress.note ? el("p", { class: "hint", text: relayProgress.note }) : null,
				el("progress", { class: "progress", value: done, max: total || 1 }),
				el("p", { class: "hint", text: `${done} / ${total} 문제 저장됨` }),
				el("p", {
					class: "hint",
					text: "이 화면을 닫으면 중간에 멈춥니다. 1~2분 걸릴 수 있어요.",
				}),
			]);
		}

		if (quiz.status === "GENERATING") {
			const percent = Math.round((progress.generated / progress.total) * 100);
			return el("section", { class: "card" }, [
				el("h2", { class: "section-title", text: "문제를 만드는 중이에요" }),
				el("p", {
					class: "status status--warn",
					text: `AI 가 문제를 만들고 스스로 검수하고 있어요 · ${elapsedText()}`,
				}),
				// CSP 가 인라인 style 을 막으므로 폭을 직접 계산해 넣을 수 없다.
				// 네이티브 <progress> 는 값만 주면 되고 접근성도 따라온다.
				el("progress", { class: "progress", value: progress.generated, max: progress.total }),
				el("p", { class: "hint", text: `${progress.generated} / ${progress.total} 문제 (${percent}%)` }),
				el("p", { class: "hint", text: "1~2분 걸릴 수 있어요. 이 화면을 열어 두세요." }),
			]);
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

		try {
			if (await usesBrowserRelay()) {
				// 브라우저가 Gemini 를 직접 부른다. 서버는 각 라운드에서 무엇을 부를지 정하고
				// 결과를 판정한다. 탭을 닫으면 중간에 멈추므로 진행 상황을 계속 보여 준다.
				relayProgress = { phase: "planning", accepted: 0, target: 0 };
				startTicking();
				await refresh();

				const result = await generateQuestions(id, (progress) => {
					relayProgress = progress;
					render(lastData);
				});

				relayProgress = null;
				stop();
				message = result.done
					? "문제가 준비되었습니다."
					: `${result.target}문제 중 ${result.accepted}개만 검수를 통과했습니다. 다시 만들면 나머지를 채웁니다.`;
				messageKind = result.done ? "info" : "error";
			} else {
				await post(`/api/quizzes/${id}/generate`);
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
