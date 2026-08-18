import { get, patch, post, put } from "../api.js";
import { identifyBook, researchBook, usesBrowserRelay } from "../ai-relay.js";
import { navigate } from "../router.js";
import { requireSession } from "../session.js";
import { banner, el, field, header, mount, selectField, setKidMode, textareaField } from "../ui.js";

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
	aladin: "알라딘",
	"kakao-book": "카카오 책",
	"google-books": "구글 북스",
	"open-library": "오픈 라이브러리",
	ai: "AI 모델 지식",
	parent: "부모가 직접 입력",
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

		const { book, sources, readyForQuiz, evidenceWeak, web } = data;
		mount(
			...[
				header(book.title, [homeLink()]),
				message ? banner(message, messageKind) : null,
				coverCard(book),
				infoCard(book),
				sourcesCard(sources, evidenceWeak, readyForQuiz, web),
				// AI 가 줄거리를 못 찾았거나 부모가 이미 적어 둔 경우에만 띄운다. 잘 된 책에는 군더더기다.
				!readyForQuiz || book.manualPlot ? plotCard(book, readyForQuiz) : null,
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

	/**
	 * 영문책의 읽기 난이도 — AR(ATOS) 과 Lexile.
	 *
	 * 읽기 전용이다. AI 가 조사해 온 값이고 부모가 손으로 고칠 성격이 아니라, 위의 입력들과
	 * 달리 form 필드가 아니라 태그로 보여 준다.
	 *
	 * 한국어 책에는 아예 매겨지지 않는 척도다. 그래서 **영문책일 때만** 자리를 만든다 —
	 * 한국어 책에 빈 칸을 띄우면 부모가 오지 않을 값을 기다리게 된다.
	 */
	function readingLevelBlock(book) {
		const level = book.readingLevel;

		if (!level) {
			if (book.language !== "en") return null;
			return el("div", { class: "field" }, [
				el("span", { class: "field__label", text: "읽기 난이도" }),
				el("p", {
					class: "hint",
					text: "AR·Lexile 을 찾지 못했어요. ‘정보 다시 찾기’ 를 누르면 다시 찾아봅니다.",
				}),
			]);
		}

		const tags = [
			// AR 레벨은 학년.개월이라 소수 첫째 자리를 늘 보인다(5 가 아니라 5.0).
			level.ar !== null ? `AR ${level.ar.toFixed(1)}` : null,
			level.arPoints !== null ? `${level.arPoints} 포인트` : null,
			level.arInterest ? `흥미 수준 ${level.arInterest}` : null,
			level.lexile ? `Lexile ${level.lexile}` : null,
		].filter(Boolean);

		return el("div", { class: "field" }, [
			el("span", { class: "field__label", text: "읽기 난이도" }),
			el(
				"div",
				{ class: "row" },
				tags.map((text) => el("span", { class: "tag tag--ok", text })),
			),
			el("p", {
				class: "hint",
				text: "미국 학교에서 쓰는 척도예요. AR 4.7 은 4학년 7개월 수준을 뜻해요.",
			}),
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
			readingLevelBlock(book),
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
							/*
							 * 실패했을 때 무엇이 없는지를 정확히 말한다.
							 *
							 * 예전 문구는 "근거 자료가 부족합니다" 였는데, 참고 자료는 멀쩡히 2건이
							 * 쌓여 있고 바로 위 카드가 "근거 자료가 충분합니다" 라고 말하는 상황에서도
							 * 그렇게 떴다. 없는 것은 참고 자료가 아니라 **줄거리**다.
							 */
							(data) =>
								data.readyForQuiz
									? data.searchNotice
									: (data.searchNotice ??
										"AI 가 이 책의 줄거리를 알지 못합니다. 아래에 줄거리를 직접 적어 주시면 문제를 만들 수 있습니다."),
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

	/**
	 * 부모가 줄거리를 직접 적는 곳.
	 *
	 * AI 가 모르는 책이 실제로 있다(실측 『움푹산의 비밀』). 무료 등급 키는 웹 검색도 못 쓰므로
	 * 그런 책은 이 입력 없이는 영영 문제를 만들 수 없다. 출판사 책소개로 대신하지 않는다 —
	 * 홍보 문구로 문제를 만들면 책을 읽지 않아도 풀린다.
	 */
	function plotCard(book, readyForQuiz) {
		const plot = textareaField("줄거리", {
			rows: 8,
			value: book.manualPlot ?? "",
			placeholder:
				"누가 무엇을 했는지 순서대로 적어 주세요. 결말까지 적으면 더 좋은 문제가 나옵니다.\n예) 잎싹은 양계장을 나와 초록머리를 기른다. …",
		});

		const card = el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: "줄거리 직접 입력" }),
			el("p", {
				class: "hint",
				text: readyForQuiz
					? "적어 두신 줄거리입니다. 고치면 문제 만들기에 바로 반영됩니다."
					: "AI 가 이 책을 알지 못합니다. 책을 보고 줄거리를 적어 주시면 그 내용으로 문제를 만듭니다.",
			}),
			plot.wrap,
			el("button", {
				class: "btn",
				type: "button",
				text: busy === "plot" ? "저장하는 중…" : "줄거리 저장",
				disabled: busy !== null,
				onClick: () =>
					run("plot", () => put(`/api/books/${id}/plot`, { plot: plot.input.value }), "줄거리를 저장했습니다."),
			}),
		]);

		return card;
	}

	/*
	 * 참고 자료의 수와 **줄거리가 있는지**는 다른 이야기다.
	 *
	 * 예전에는 여기서 자료 수만 보고 "근거 자료가 충분합니다" 라고 했다. 그래서 줄거리를 못 찾은
	 * 책에서 이 카드는 "충분합니다", 바로 아래 퀴즈 카드는 "먼저 책 정보를 찾아 주세요" 라고
	 * 동시에 말했다. 같은 화면이 서로 반대되는 말을 하면 저장이 고장 난 것처럼 보인다.
	 */
	/**
	 * 웹 자료 재검색. **크레딧을 쓰는 유일한 사용자 조작**이므로 누르기 전에 몇 번 남았는지 보인다.
	 *
	 * 책당 횟수와 이달 서비스 전체 크레딧, 둘 중 하나라도 바닥나면 잠긴다.
	 */
	function webSearchRow(web) {
		if (!web?.enabled) return null;

		const left = web.searchesLeft ?? 0;
		const credits = web.creditsLeft ?? 0;
		const blocked = left === 0 || credits < 3;

		return el("div", { class: "row" }, [
			el("button", {
				class: "btn btn--secondary",
				type: "button",
				text: busy === "web" ? "웹에서 찾는 중…" : "웹 자료 다시 찾기",
				disabled: busy !== null || blocked,
				onClick: () =>
					run("web", () => post(`/api/books/${id}/web-search`), "웹 자료를 다시 찾았습니다.", (d) => d.notice),
			}),
			el("span", {
				class: "hint",
				text:
					left === 0
						? "이 책의 재검색 횟수를 다 썼습니다."
						: credits < 3
							? "이달 웹 검색 한도를 다 썼습니다."
							: `이 책 ${left}회 남음 · 이달 전체 ${credits} 크레딧 남음`,
			}),
		]);
	}

	function sourcesCard(sources, evidenceWeak, readyForQuiz, web) {
		const status = !readyForQuiz
			? { kind: "warn", text: "자료는 찾았지만 줄거리를 얻지 못했습니다. 이 자료만으로는 문제를 만들 수 없습니다." }
			: evidenceWeak
				? { kind: "warn", text: "웹에서 찾은 근거가 2건 미만입니다. 문제는 만들 수 있지만 내용이 맞는지 더 꼼꼼히 확인해 주세요." }
				: { kind: "ok", text: "근거 자료가 충분합니다." };

		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: `참고 자료 ${sources.length}건` }),
			el("p", { class: `status status--${status.kind}`, text: status.text }),
			webSearchRow(web),
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
						// 이미 찾아 본 책에 "먼저 찾아 주세요" 라고 하면 저장이 안 된 것처럼 읽힌다.
						text: book.searchedAt
							? "책 정보는 찾았지만 AI 가 줄거리를 정리하지 못했습니다. 위에 줄거리를 직접 적어 주시면 문제를 만들 수 있습니다."
							: "먼저 책 정보를 찾아 주세요. 줄거리 없이는 문제를 만들 수 없습니다.",
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
		// 줄거리 저장은 AI 를 부르지 않는다. 부르지도 않은 것을 기다리라고 하지 않는다.
		message =
			kind === "plot"
				? "저장하는 중입니다."
				: kind === "web"
					? "웹에서 자료를 찾는 중입니다."
					: "잠시만 기다려 주세요. AI 가 작업 중입니다.";
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
