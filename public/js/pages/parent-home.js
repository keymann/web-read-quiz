import { get } from "../api.js";
import { logout, requireSession } from "../session.js";
import { banner, el, header, mount, setKidMode } from "../ui.js";

/**
 * 부모 홈 = 대시보드(§19).
 *
 * 부모가 알고 싶은 것은 "우리 아이가 책을 읽고 있는가" 한 가지다. 그래서 가장 큰 숫자는
 * 점수가 아니라 **끝까지 읽은 책 수**다. 점수는 그 아래 눈대중용으로만 둔다.
 *
 * 화면 순서는 §19 그대로 — 내 아이 → 최근 독서 퀴즈 → 다음 단계.
 */

const formatDate = (iso) => {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;

	const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
	if (days === 0) return "오늘";
	if (days === 1) return "어제";
	if (days < 7) return `${days}일 전`;
	return `${d.getMonth() + 1}월 ${d.getDate()}일`;
};

export async function parentHomePage() {
	setKidMode(false);
	const s = await requireSession("PARENT");
	if (!s) return;

	let dashboard = { children: [], recent: [], totals: { booksPassed: 0, attempts: 0, passed: 0 } };
	let settings = null;
	let error = null;

	try {
		[dashboard, settings] = await Promise.all([get("/api/dashboard"), get("/api/settings")]);
	} catch (err) {
		error = err.message;
	}

	mount(
		...[
			header(`${s.displayName} 님`, [
				el("a", { class: "btn btn--secondary", href: "/parent/books", "data-link": true, text: "내 책장" }),
				el("a", { class: "btn btn--secondary", href: "/parent/children", "data-link": true, text: "아이 관리" }),
				el("a", { class: "btn btn--secondary", href: "/parent/settings", "data-link": true, text: "설정" }),
				el("button", { class: "btn btn--ghost", text: "로그아웃", onClick: logout }),
			]),
			error ? banner(error) : null,
			dashboard.totals.attempts > 0 ? totalsCard() : null,
			childrenCard(),
			dashboard.recent.length > 0 ? recentCard() : null,
			nextStepCard(),
		].filter(Boolean),
	);

	/** 집 전체 합계. 아이가 여럿일 때 한눈에 보라고 둔다. */
	function totalsCard() {
		const { booksPassed, attempts, passed } = dashboard.totals;

		return el("section", { class: "card" }, [
			el("div", { class: "stat-row" }, [
				stat(booksPassed, "권 읽음", true),
				stat(attempts, "번 도전"),
				stat(passed, "번 통과"),
			]),
		]);
	}

	function stat(value, label, primary = false) {
		return el("div", { class: primary ? "stat stat--primary" : "stat" }, [
			el("span", { class: "stat__value", text: String(value) }),
			el("span", { class: "stat__label", text: label }),
		]);
	}

	function childrenCard() {
		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: "내 아이" }),
			dashboard.children.length === 0
				? el("div", { class: "empty" }, [
						el("p", { text: "아직 등록된 아이가 없어요." }),
						el("a", { class: "btn", href: "/parent/children", "data-link": true, text: "아이 추가하기" }),
					])
				: el("ul", { class: "list" }, dashboard.children.map(childItem)),
		]);
	}

	function childItem(child) {
		const { stats } = child;
		const meta =
			stats.attempts === 0
				? "아직 푼 퀴즈가 없어요"
				: `${stats.booksPassed}권 읽음 · ${stats.attempts}번 도전` +
					(stats.retries > 0 ? ` · 재도전 ${stats.retries}번` : "") +
					(stats.averageScore === null ? "" : ` · 평균 ${stats.averageScore}점`);

		return el("li", { class: "list__item" }, [
			el("div", { class: "list__main" }, [
				el("span", {
					class: "list__title",
					text: child.grade ? `${child.name} (${child.grade}학년)` : child.name,
				}),
				el("span", { class: "list__meta", text: meta }),
			]),
			stats.lastPlayedAt
				? el("span", { class: "list__meta", text: formatDate(stats.lastPlayedAt) })
				: null,
			el("a", {
				class: "btn btn--ghost",
				href: `/parent/children/${child.id}`,
				"data-link": true,
				text: "자세히",
			}),
		]);
	}

	function recentCard() {
		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: "최근 독서 퀴즈" }),
			el(
				"ul",
				{ class: "list" },
				dashboard.recent.map((attempt) =>
					el("li", { class: "list__item" }, [
						el("div", { class: "list__main" }, [
							el("span", { class: "list__title", text: attempt.bookTitle }),
							el("span", {
								class: "list__meta",
								text: `${attempt.childName} · ${attempt.round}회차 · ${formatDate(attempt.startedAt)}`,
							}),
						]),
						el("span", {
							class: attemptTagClass(attempt),
							text: attemptTagText(attempt),
						}),
					]),
				),
			),
		]);
	}

	function attemptTagClass(attempt) {
		if (!attempt.completedAt) return "tag";
		return attempt.passed ? "tag tag--ok" : "tag tag--warn";
	}

	function attemptTagText(attempt) {
		if (!attempt.completedAt) return "푸는 중";
		return attempt.passed
			? `통과 · ${attempt.correctCount}/${attempt.total}`
			: `재도전 · ${attempt.correctCount}/${attempt.total}`;
	}

	function nextStepCard() {
		return el("section", { class: "card card--muted" }, [
			el("h2", { class: "section-title", text: "다음 단계" }),
			settings?.ai.configured
				? el("div", { class: "empty" }, [
						el("p", { text: "책 표지를 찍으면 AI 가 책을 알아보고 정보를 모읍니다." }),
						el("a", { class: "btn", href: "/parent/books/new", "data-link": true, text: "책 등록하기" }),
					])
				: el("div", { class: "empty" }, [
						el("p", { text: "문제를 만들려면 먼저 AI API Key 를 등록해야 합니다." }),
						el("a", { class: "btn", href: "/parent/settings", "data-link": true, text: "설정으로 가기" }),
					]),
		]);
	}
}
