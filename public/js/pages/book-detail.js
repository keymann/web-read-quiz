import { get, patch, post } from "../api.js";
import { navigate } from "../router.js";
import { requireSession } from "../session.js";
import { banner, el, field, header, mount, setKidMode } from "../ui.js";

/**
 * 책 분석 화면 — AI 식별 → 부모 확인/보정 → 정보 검색(§5·§6).
 *
 * AI 가 표지를 잘못 읽는 일이 흔하므로 각 단계 사이에 부모가 값을 고칠 수 있어야 하고,
 * 고친 값이 다음 단계의 입력이 되어야 한다.
 */
export async function bookDetailPage({ id }) {
	setKidMode(false);
	const s = await requireSession("PARENT");
	if (!s) return;

	let message = null;
	let messageKind = "error";
	let busy = null;

	await refresh();

	async function refresh() {
		let data = null;
		try {
			data = await get(`/api/books/${id}`);
		} catch (err) {
			message = err.message;
			messageKind = "error";
		}
		render(data);
	}

	function render(data) {
		if (!data) {
			mount(header("책", [homeLink()]), message ? banner(message, messageKind) : null);
			return;
		}

		const { book, sources, readyForQuiz } = data;
		mount(
			...[
				header(book.title, [homeLink()]),
				message ? banner(message, messageKind) : null,
				coverCard(book),
				infoCard(book),
				sourcesCard(sources, readyForQuiz),
				quizCard(book, readyForQuiz),
			].filter(Boolean),
		);
	}

	// 화살표 함수를 const 로 두면 render() 가 먼저 실행될 때 TDZ 에 걸린다. 선언식으로 둔다.
	function homeLink() {
		return el("a", { class: "btn btn--ghost", href: "/parent/books", "data-link": true, text: "← 책 목록" });
	}

	function coverCard(book) {
		const confidence =
			book.aiConfidence === null
				? null
				: el("p", {
						class: book.aiConfidence < 0.6 ? "status status--warn" : "status status--ok",
						text:
							book.aiConfidence < 0.6
								? `표지를 또렷하게 읽지 못했습니다 (정확도 ${Math.round(book.aiConfidence * 100)}%). 아래 정보를 직접 확인해 주세요.`
								: `표지 인식 정확도 ${Math.round(book.aiConfidence * 100)}%`,
					});

		return el("section", { class: "card book-head" }, [
			el("img", { class: "book-cover", src: book.coverUrl, alt: `${book.title} 표지` }),
			el("div", { class: "book-head__body" }, [
				confidence,
				el("p", { class: "hint", text: book.analyzedAt ? "AI 분석 완료" : "아직 분석하지 않았습니다." }),
				el("button", {
					class: "btn btn--block",
					type: "button",
					text: busy === "analyze" ? "표지를 읽는 중…" : book.analyzedAt ? "다시 분석하기" : "AI 로 책 정보 읽기",
					disabled: busy !== null,
					onClick: () => run("analyze", `/api/books/${id}/analyze`, "표지에서 책 정보를 읽었습니다."),
				}),
			]),
		]);
	}

	function infoCard(book) {
		const title = field("제목", { value: book.title, required: true });
		const author = field("지은이", { value: book.author ?? "" });
		const publisher = field("출판사", { value: book.publisher ?? "" });
		const isbn13 = field("ISBN", { value: book.isbn13 ?? book.isbn10 ?? "" });

		const form = el("form", { class: "card" }, [
			el("h2", { class: "section-title", text: "책 정보" }),
			el("p", { class: "hint", text: "AI 가 잘못 읽은 부분이 있으면 직접 고쳐 주세요. 고친 값으로 정보를 찾습니다." }),
			title.wrap,
			author.wrap,
			publisher.wrap,
			isbn13.wrap,
			el("div", { class: "row" }, [
				el("button", { class: "btn btn--secondary", type: "submit", text: "정보 저장", disabled: busy !== null }),
				el("button", {
					class: "btn",
					type: "button",
					text: busy === "search" ? "책 정보를 찾는 중…" : book.searchedAt ? "정보 다시 찾기" : "책 정보 찾기",
					disabled: busy !== null,
					onClick: () =>
						run("search", `/api/books/${id}/search`, "책 정보를 찾아 정리했습니다.", (data) =>
							data.readyForQuiz
								? data.searchNotice
								: data.searchNotice ??
									"근거 자료가 부족합니다. 제목·지은이를 다시 확인하거나 정보를 한 번 더 찾아 주세요.",
						),
				}),
			]),
		]);

		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			try {
				await patch(`/api/books/${id}`, {
					title: title.input.value,
					author: author.input.value,
					publisher: publisher.input.value,
					isbn13: isbn13.input.value,
				});
				message = "책 정보를 저장했습니다.";
				messageKind = "info";
			} catch (err) {
				message = err.message;
				messageKind = "error";
			}
			await refresh();
		});

		return form;
	}

	function sourcesCard(sources, readyForQuiz) {
		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: `참고 자료 ${sources.length}건` }),
			el("p", {
				class: readyForQuiz ? "status status--ok" : "status status--warn",
				text: readyForQuiz
					? "문제를 만들 준비가 되었습니다."
					: "문제를 만들려면 참고 자료가 2건 이상 필요합니다. AI 가 없는 내용을 지어내지 않게 하기 위한 기준입니다.",
			}),
			sources.length === 0
				? el("p", { class: "hint", text: "아직 찾은 자료가 없습니다." })
				: el(
						"ul",
						{ class: "list" },
						sources.map((source) =>
							el("li", { class: "list__item list__item--stacked" }, [
								el("div", { class: "list__main" }, [
									el("span", { class: "list__title", text: source.title ?? source.url ?? "(제목 없음)" }),
									el("span", { class: "list__meta", text: source.source }),
								]),
								source.url
									? el("a", {
											class: "btn btn--ghost",
											href: source.url,
											target: "_blank",
											rel: "noopener noreferrer",
											text: "열기",
										})
									: null,
								source.content ? el("p", { class: "source-excerpt", text: source.content }) : null,
							]),
						),
					),
		]);
	}

	/** 문제 생성 진입. 퀴즈를 만들고 생성을 시작한 뒤 검수 화면으로 넘긴다. */
	function quizCard(book, readyForQuiz) {
		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: "독서 퀴즈" }),
			readyForQuiz
				? el("p", { class: "hint", text: "이 책 정보로 4지선다 20문제를 만듭니다. 1~2분 걸립니다." })
				: el("p", {
						class: "status status--warn",
						text: "먼저 책 정보를 찾아 주세요. 줄거리 없이는 문제를 만들 수 없습니다.",
					}),
			el("button", {
				class: "btn",
				type: "button",
				text: "문제 만들기",
				disabled: !readyForQuiz || busy !== null,
				onClick: async () => {
					busy = "quiz";
					message = "퀴즈를 만드는 중입니다.";
					messageKind = "info";
					await refresh();
					try {
						const { quiz } = await post("/api/quizzes", { bookId: book.id });
						await post(`/api/quizzes/${quiz.id}/generate`);
						await navigate(`/parent/quizzes/${quiz.id}`);
						return;
					} catch (err) {
						message = err.message;
						messageKind = "error";
					}
					busy = null;
					await refresh();
				},
			}),
		]);
	}

	/** 시간이 걸리는 AI 호출을 공통으로 처리한다. 진행 중에는 버튼을 잠근다. */
	async function run(kind, path, successMessage, warn) {
		busy = kind;
		message = "잠시만 기다려 주세요. AI 가 작업 중입니다.";
		messageKind = "info";
		await refresh();

		try {
			const data = await post(path);
			const warning = warn ? warn(data) : null;
			// 모델 폴백은 결과 차이를 설명해 주는 정보라 성공 메시지에도 덧붙인다.
			message = [warning ?? successMessage, data.modelNotice].filter(Boolean).join(" ");
			messageKind = warning ? "error" : "info";
		} catch (err) {
			message = err.message;
			messageKind = "error";
		}
		busy = null;
		await refresh();
	}
}
