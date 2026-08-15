import { get } from "../api.js";
import { requireSession } from "../session.js";
import { banner, el, header, mount, setKidMode } from "../ui.js";

/**
 * 아이 한 명의 독서 기록(§19).
 *
 * 총계 → 책별 → 회차별 순으로 좁혀 간다. 부모가 "몇 권 읽었나" 에서 시작해 "이 책은 몇 번
 * 만에 통과했나" 까지 한 화면에서 따라갈 수 있어야 한다.
 */

const formatDate = (iso) => {
	if (!iso) return "";
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? iso
		: `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
};

export async function childHistoryPage({ id }) {
	setKidMode(false);
	const s = await requireSession("PARENT");
	if (!s) return;

	let summary = null;
	let error = null;

	try {
		summary = await get(`/api/children/${id}/summary`);
	} catch (err) {
		error = err.message;
	}

	if (!summary) {
		mount(header("독서 기록", [backLink()]), banner(error ?? "기록을 불러오지 못했습니다."));
		return;
	}

	const { child, stats, books, attempts } = summary;

	mount(
		...[
			header(child.grade ? `${child.name} (${child.grade}학년)` : child.name, [backLink()]),
			statsCard(),
			books.length > 0 ? booksCard() : emptyCard(),
			attempts.length > 0 ? attemptsCard() : null,
		].filter(Boolean),
	);

	function backLink() {
		return el("a", { class: "btn btn--ghost", href: "/parent", "data-link": true, text: "← 홈" });
	}

	function statsCard() {
		return el("section", { class: "card" }, [
			el("div", { class: "stat-row" }, [
				stat(stats.booksPassed, "권 읽음", true),
				stat(stats.attempts, "번 도전"),
				stat(stats.passed, "번 통과"),
				stat(stats.retries, "번 재도전"),
			]),
			stats.averageScore === null
				? null
				: el("p", {
						class: "hint",
						text: `평균 ${stats.averageScore}점 · 마지막 도전 ${formatDate(stats.lastPlayedAt)}`,
					}),
		]);
	}

	function stat(value, label, primary = false) {
		return el("div", { class: primary ? "stat stat--primary" : "stat" }, [
			el("span", { class: "stat__value", text: String(value) }),
			el("span", { class: "stat__label", text: label }),
		]);
	}

	function emptyCard() {
		return el("section", { class: "card" }, [
			el("div", { class: "empty" }, [
				el("p", { text: `${child.name} 이(가) 아직 퀴즈를 풀지 않았어요.` }),
				el("a", { class: "btn", href: "/parent/books", "data-link": true, text: "책장으로 가기" }),
			]),
		]);
	}

	/** 책별 요약. 몇 번 만에 통과했는지가 이 화면의 핵심 정보다. */
	function booksCard() {
		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: `도전한 책 ${books.length}권` }),
			el(
				"ul",
				{ class: "list" },
				books.map((book) =>
					el("li", { class: "list__item" }, [
						el("div", { class: "list__main" }, [
							el("span", { class: "list__title", text: book.bookTitle }),
							el("span", {
								class: "list__meta",
								text:
									`${book.attempts}번 도전 · 최고 ${book.bestScore}점 · ${formatDate(book.lastPlayedAt)}`,
							}),
						]),
						el("span", {
							class: book.passed ? "tag tag--ok" : "tag tag--warn",
							text: book.passed ? "읽음" : "도전 중",
						}),
						el("a", {
							class: "btn btn--ghost",
							href: `/parent/books/${book.bookId}`,
							"data-link": true,
							text: "책 보기",
						}),
					]),
				),
			),
		]);
	}

	/** 회차별 기록. 같은 책을 여러 번 푼 흐름이 여기서 보인다. */
	function attemptsCard() {
		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: "회차별 기록" }),
			el(
				"ul",
				{ class: "list" },
				attempts.map((attempt) =>
					el("li", { class: "list__item" }, [
						el("div", { class: "list__main" }, [
							el("span", {
								class: "list__title",
								text: `${attempt.bookTitle} · ${attempt.round}회차`,
							}),
							el("span", {
								class: "list__meta",
								text: attempt.completedAt
									? `${attempt.total}문제 중 ${attempt.correctCount}개 정답 · ${formatDate(attempt.startedAt)}`
									: `푸는 중 · ${formatDate(attempt.startedAt)}`,
							}),
						]),
						el("span", {
							class: !attempt.completedAt
								? "tag"
								: attempt.passed
									? "tag tag--ok"
									: "tag tag--warn",
							text: !attempt.completedAt
								? "푸는 중"
								: attempt.passed
									? `통과 · ${attempt.score}점`
									: `${attempt.score}점`,
						}),
					]),
				),
			),
		]);
	}
}
