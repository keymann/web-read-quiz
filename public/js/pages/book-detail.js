import { get, patch, post } from "../api.js";
import { identifyBook, researchBook, usesBrowserRelay } from "../ai-relay.js";
import { navigate } from "../router.js";
import { requireSession } from "../session.js";
import { banner, el, field, header, mount, selectField, setKidMode } from "../ui.js";

/**
 * 책 분석 화면 — AI 식별 → 부모 확인/보정 → 정보 검색(§5·§6).
 *
 * AI 가 표지를 잘못 읽는 일이 흔하므로 각 단계 사이에 부모가 값을 고칠 수 있어야 하고,
 * 고친 값이 다음 단계의 입력이 되어야 한다.
 */
// 출처 종류를 사람이 읽을 수 있는 이름으로. 모르는 값은 그대로 보여준다.
// 모듈 수준에 둔다 — 페이지 함수 안의 const 는 첫 render() 보다 아래에 놓이면 TDZ 로 터진다.
const SOURCE_LABEL = {
	web: "웹 검색",
	"google-books": "구글 북스",
	"open-library": "오픈 라이브러리",
	ai: "AI 모델 지식",
};

export async function bookDetailPage({ id }) {
	setKidMode(false);
	const s = await requireSession("PARENT");
	if (!s) return;

	let message = null;
	let messageKind = "error";
	let busy = null;
	/** 부모의 기본 출제 설정. 문제 언어를 이 판만 바꿀 수 있게 화면에 띄운다. */
	let quizDefaults = null;
	/** 이 책의 퀴즈 회차. 재도전으로 생긴 "만들다 만 회차" 를 여기서 찾는다. */
	let quizzes = [];
	/** 이 책에 아이들이 도전한 기록. 몇 번 만에 통과했는지가 여기 보인다. */
	let attempts = [];

	await refresh();

	async function refresh() {
		let data = null;
		try {
			if (quizDefaults === null) quizDefaults = (await get("/api/settings")).quiz;
			data = await get(`/api/books/${id}`);
			({ quizzes } = await get(`/api/books/${id}/quizzes`));
			({ attempts } = await get(`/api/books/${id}/history`));
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

		const { book, sources, readyForQuiz, evidenceWeak } = data;
		mount(
			...[
				header(book.title, [homeLink()]),
				message ? banner(message, messageKind) : null,
				coverCard(book),
				infoCard(book),
				sourcesCard(sources, evidenceWeak),
				attempts.length > 0 ? attemptsCard() : null,
				quizzes.length > 0 ? roundsCard() : null,
				quizCard(book, readyForQuiz, evidenceWeak),
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
					onClick: () =>
							run(
								"analyze",
								(relay) => (relay ? identifyBook(id) : post(`/api/books/${id}/analyze`)),
								"표지에서 책 정보를 읽었습니다.",
							),
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
						run(
							"search",
							(relay) => (relay ? researchBook(id) : post(`/api/books/${id}/search`)),
							"책 정보를 찾아 정리했습니다.",
							(data) =>
								data.readyForQuiz
									? data.searchNotice
									: (data.searchNotice ??
										"근거 자료가 부족합니다. 제목·지은이를 다시 확인하거나 정보를 한 번 더 찾아 주세요."),
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

	function sourcesCard(sources, evidenceWeak) {
		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: `참고 자료 ${sources.length}건` }),
			el("p", {
				class: evidenceWeak ? "status status--warn" : "status status--ok",
				text: evidenceWeak
					? "웹에서 찾은 근거가 2건 미만입니다. 문제는 만들 수 있지만 내용이 맞는지 더 꼼꼼히 확인해 주세요."
					: "근거 자료가 충분합니다.",
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
									el("span", {
										class: source.source === "ai" ? "list__meta list__meta--weak" : "list__meta",
										text: SOURCE_LABEL[source.source] ?? source.source,
									}),
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

	/** 이 책에 누가 몇 번 도전했는지(§19). */
	function attemptsCard() {
		const passed = attempts.filter((a) => a.passed).length;

		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: `도전 기록 ${attempts.length}번` }),
			el("p", {
				class: passed > 0 ? "status status--ok" : "status status--warn",
				text: passed > 0 ? `${passed}번 통과했습니다.` : "아직 통과한 도전이 없습니다.",
			}),
			el(
				"ul",
				{ class: "list" },
				attempts.map((attempt) =>
					el("li", { class: "list__item" }, [
						el("div", { class: "list__main" }, [
							el("span", {
								class: "list__title",
								text: `${attempt.childName} · ${attempt.round}회차`,
							}),
							el("span", {
								class: "list__meta",
								text: attempt.completedAt
									? `${attempt.total}문제 중 ${attempt.correctCount}개 정답`
									: "푸는 중",
							}),
						]),
						el("span", {
							class: !attempt.completedAt ? "tag" : attempt.passed ? "tag tag--ok" : "tag tag--warn",
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

	/**
	 * 이 책의 회차 목록.
	 *
	 * 재도전(§18)은 아이가 눌러 새 회차를 만든다. 그런데 Gemini 를 쓰는 경우 서버가 문제를
	 * 만들 수 없어(지역 차단) **부모의 브라우저가 만들어 줘야 한다.** 그 회차를 여기서 찾아
	 * 들어갈 수 있게 한다.
	 */
	function roundsCard() {
		const LANGUAGE = { en: "영어", ko: "한국어" };

		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: `퀴즈 회차 ${quizzes.length}개` }),
			el(
				"ul",
				{ class: "list" },
				quizzes.map((quiz) => {
					const pending = quiz.generated < quiz.questionCount;

					return el("li", { class: "list__item" }, [
						el("div", { class: "list__main" }, [
							el("span", {
								class: "list__title",
								text: `${quiz.round}회차 · ${LANGUAGE[quiz.language] ?? quiz.language}`,
							}),
							el("span", {
								class: "list__meta",
								text: `${quiz.generated} / ${quiz.questionCount} 문제`,
							}),
						]),
						pending ? el("span", { class: "tag tag--warn", text: "문제 부족" }) : null,
						el("a", {
							class: pending ? "btn" : "btn btn--ghost",
							href: `/parent/quizzes/${quiz.id}`,
							"data-link": true,
							text: pending ? "문제 만들기" : "보기",
						}),
					]);
				}),
			),
		]);
	}

	/** 문제 생성 진입. 퀴즈를 만들고 생성을 시작한 뒤 검수 화면으로 넘긴다. */
	function quizCard(book, readyForQuiz, evidenceWeak) {
		// 이 판만 다른 언어로 낼 수 있다. 기본값은 설정 → 출제 설정의 값.
		const language = selectField(
			"문제 언어",
			quizDefaults?.languages ?? [{ value: "en", label: "영어" }],
			quizDefaults?.questionLanguage ?? "en",
		);

		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: "독서 퀴즈" }),
			readyForQuiz
				? el("p", {
						class: "hint",
						text: `이 책 정보로 4지선다 문제 ${quizDefaults?.questionCount ?? 20}개를 만듭니다. 개수는 설정 → 출제 설정에서 정합니다. 1~2분 걸립니다.`,
					})
				: el("p", {
						class: "status status--warn",
						text: "먼저 책 정보를 찾아 주세요. 줄거리 없이는 문제를 만들 수 없습니다.",
					}),
			readyForQuiz && evidenceWeak
				? el("p", { class: "hint", text: "근거가 얇으니 만들어진 문제를 꼭 검수해 주세요." })
				: null,
			readyForQuiz ? language.wrap : null,
			el("button", {
				class: "btn",
				type: "button",
				text: "문제 만들기",
				disabled: !readyForQuiz || busy !== null,
				onClick: async () => {
					busy = "quiz";
					message = "퀴즈를 만드는 중입니다.";
					messageKind = "info";
					const chosen = language.select.value;
					await refresh();
					try {
						const { quiz } = await post("/api/quizzes", { bookId: book.id, language: chosen });
						// 브라우저 릴레이에서는 검수 화면이 생성 루프를 직접 돌린다.
						// 서버에게 시작을 시키면 홍콩 콜로에서 나가 Gemini 에 막힌다.
						if (!(await usesBrowserRelay())) await post(`/api/quizzes/${quiz.id}/generate`);
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

	/**
	 * 시간이 걸리는 AI 호출을 공통으로 처리한다. 진행 중에는 버튼을 잠근다.
	 *
	 * `execute` 는 브라우저 릴레이 여부를 받아 실제 호출을 수행한다. Gemini 를 쓰는 경우에만
	 * 브라우저가 직접 부르고, 그 외에는 서버가 부른다.
	 */
	async function run(kind, execute, successMessage, warn) {
		busy = kind;
		message = "잠시만 기다려 주세요. AI 가 작업 중입니다.";
		messageKind = "info";
		await refresh();

		try {
			const data = await execute(await usesBrowserRelay());
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
