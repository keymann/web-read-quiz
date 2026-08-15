import { get } from "../api.js";
import { el, selectField } from "../ui.js";

/**
 * 이력 탭 — 문제 이력과 답안 이력(§12·§16).
 *
 * 문제 이력: AI 가 무엇을 만들었고 부모가 무엇을 고쳤는지.
 * 답안 이력: 아이가 어떤 문제에 무엇을 답했는지. 아이가 **그때 본 문항 본문**을 보여주므로
 *            이후 부모가 문제를 고쳐도 과거 기록은 그대로다(§22).
 */

const ACTION_LABEL = {
	AI_GENERATED: "AI 생성",
	AI_REGENERATED: "AI 재생성",
	PARENT_EDITED: "부모 수정",
	PARENT_DELETED: "부모 삭제",
	PARENT_APPROVED: "부모 승인",
};

const ACTION_CLASS = {
	AI_GENERATED: "tag--ok",
	AI_REGENERATED: "tag--ok",
	PARENT_DELETED: "tag--warn",
};

const formatTime = (iso) => {
	if (!iso) return "";
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? iso
		: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export function historyPanel({ onMessage }) {
	const container = el("div");

	/** 화면 상태. 필터가 바뀌면 그대로 다시 불러온다. */
	const state = { kind: "questions", bookId: "", childId: "", filters: null, entries: [], loading: true };

	load();
	return container;

	async function load() {
		state.loading = true;
		render();
		try {
			if (!state.filters) state.filters = await get("/api/history/filters");

			const params = new URLSearchParams({ limit: "50" });
			if (state.bookId) params.set("bookId", state.bookId);
			if (state.childId && state.kind === "answers") params.set("childId", state.childId);

			const data = await get(`/api/history/${state.kind}?${params}`);
			state.entries = data.entries;
		} catch (err) {
			state.entries = [];
			onMessage(err.message, "error");
		}
		state.loading = false;
		render();
	}

	function render() {
		container.replaceChildren(
			...[filterCard(), state.loading ? loadingCard() : listCard()].filter(Boolean),
		);
	}

	function loadingCard() {
		return el("section", { class: "card" }, [el("p", { class: "hint", text: "불러오는 중…" })]);
	}

	function filterCard() {
		const books = state.filters?.books ?? [];
		const children = state.filters?.children ?? [];

		const bookNames = ["전체 책", ...books.map((b) => b.title)];
		const book = selectField("책", bookNames, state.bookId ? titleOf(books, state.bookId) : "전체 책");
		book.select.addEventListener("change", () => {
			const found = books.find((b) => b.title === book.select.value);
			state.bookId = found ? found.id : "";
			load();
		});

		const childNames = ["전체 아이", ...children.map((c) => c.name)];
		const child = selectField("아이", childNames, state.childId ? nameOf(children, state.childId) : "전체 아이");
		child.select.addEventListener("change", () => {
			const found = children.find((c) => c.name === child.select.value);
			state.childId = found ? found.id : "";
			load();
		});

		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: "이력" }),
			el("div", { class: "row" }, [
				kindButton("questions", "문제 이력"),
				kindButton("answers", "답안 이력"),
			]),
			book.wrap,
			// 아이 필터는 답안 이력에서만 의미가 있다.
			state.kind === "answers" ? child.wrap : null,
		]);
	}

	// 화살표 함수를 const 로 두면 render() 가 먼저 실행될 때 TDZ 에 걸린다. 선언식으로 둔다.
	function titleOf(books, id) {
		return books.find((b) => b.id === id)?.title ?? "전체 책";
	}

	function nameOf(children, id) {
		return children.find((c) => c.id === id)?.name ?? "전체 아이";
	}

	function kindButton(kind, label) {
		return el("button", {
			class: state.kind === kind ? "btn" : "btn btn--secondary",
			type: "button",
			text: label,
			"aria-pressed": state.kind === kind,
			onClick: () => {
				if (state.kind === kind) return;
				state.kind = kind;
				load();
			},
		});
	}

	function listCard() {
		if (state.entries.length === 0) {
			return el("section", { class: "card" }, [
				el("p", {
					class: "hint",
					text:
						state.kind === "questions"
							? "아직 문제 이력이 없습니다. 책을 등록하고 문제를 만들면 여기에 쌓입니다."
							: "아직 답안 이력이 없습니다. 아이가 퀴즈를 풀면 여기에 쌓입니다.",
				}),
			]);
		}

		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: `${state.entries.length}건` }),
			el(
				"ul",
				{ class: "list" },
				state.entries.map(state.kind === "questions" ? questionEntry : answerEntry),
			),
		]);
	}

	/**
	 * 선택지 목록. 정답에 표시를 남기고, 아이가 고른 답이 있으면 그것도 함께 표시한다.
	 *
	 * 문항 본문만으로는 부모가 "이게 맞는 문제인가" 를 판단할 수 없다. 번호만 적어 두는 것도
	 * 마찬가지다 — "고른 답 2, 정답 4" 를 보려면 문제를 다시 찾아 대조해야 한다.
	 */
	function choiceList(choices, { correct, selected } = {}) {
		if (!choices?.length) return null;

		return el(
			"ol",
			{ class: "history__choices" },
			choices.map((choice, index) => {
				const number = index + 1;
				const isCorrect = number === correct;
				const isSelected = number === selected;

				return el("li", { class: isCorrect ? "is-answer" : isSelected ? "is-picked" : "" }, [
					el("span", { text: choice }),
					isCorrect ? el("span", { class: "tag tag--ok", text: "정답" }) : null,
					isSelected && !isCorrect ? el("span", { class: "tag tag--warn", text: "고른 답" }) : null,
					isSelected && isCorrect ? el("span", { class: "tag tag--ok", text: "고른 답" }) : null,
				]);
			}),
		);
	}

	function questionEntry(entry) {
		const changed =
			entry.before?.questionText && entry.before.questionText !== entry.after?.questionText;

		return el("li", { class: "list__item list__item--stacked" }, [
			el("div", { class: "list__main" }, [
				el("span", { class: "list__title", text: `${entry.questionNumber}. ${entry.questionText}` }),
				el("span", {
					class: "list__meta",
					text: `${entry.bookTitle} · ${entry.quizRound}회차 · ${formatTime(entry.createdAt)}`,
				}),
			]),
			el("span", {
				class: `tag ${ACTION_CLASS[entry.action] ?? ""}`.trim(),
				text: ACTION_LABEL[entry.action] ?? entry.action,
			}),
			choiceList(entry.choices, { correct: entry.correctChoice }),
			changed
				? el("p", { class: "source-excerpt", text: `수정 전 · ${entry.before.questionText}` })
				: null,
		]);
	}

	function answerEntry(entry) {
		return el("li", { class: "list__item list__item--stacked" }, [
			el("div", { class: "list__main" }, [
				el("span", { class: "list__title", text: `${entry.questionNumber}. ${entry.questionText}` }),
				el("span", {
					class: "list__meta",
					text: `${entry.childName} · ${entry.bookTitle} ${entry.quizRound}회차 · ${formatTime(entry.answeredAt)}`,
				}),
			]),
			el("span", {
				class: entry.isCorrect ? "tag tag--ok" : "tag tag--warn",
				text: entry.isCorrect ? "정답" : "오답",
			}),
			choiceList(entry.choices, { correct: entry.correctChoice, selected: entry.selectedChoice }),
		]);
	}
}
