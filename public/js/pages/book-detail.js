import { del, get, patch, post, put, upload } from "../api.js";
import { identifyBook, orientCover, researchBook, usesBrowserRelay } from "../ai-relay.js";
import { rotateImage } from "../image.js";
import { navigate } from "../router.js";
import { requireSession } from "../session.js";
import {
	banner,
	confirmDialog,
	el,
	field,
	header,
	mount,
	selectField,
	setKidMode,
	textareaField,
} from "../ui.js";

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

/**
 * 표지 방향 보정을 한 화면에서 몇 번까지 시도할지.
 *
 * 실패가 이어지는 상황(키 없음·모델 차단)에서 `refresh()` 마다 다시 걸면 화면이 계속
 * "확인 중" 으로 보인다. 부모가 분석을 누르면 이 셈이 0 으로 돌아가 다시 기회를 얻는다.
 */
const MAX_COVER_FIX = 2;

/** 주소에서 사이트 이름만. 주소가 없거나 깨졌으면 "웹 검색" 으로 되돌린다. */
function hostOf(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return SOURCE_LABEL.web;
	}
}

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
	/**
	 * 표지 방향 보정의 진행 상태. `null` · `"check"`(판정 중) · `"turn"`(돌려 올리는 중).
	 * 부모가 누르지 않은 일이 도는 중이므로 무슨 일이 벌어지는지는 화면에 적어야 한다.
	 */
	let coverFixing = null;
	/**
	 * 이 화면에서 방향 보정을 몇 번 시도했는지.
	 *
	 * 실패를 무한히 되풀이하지 않으려고 센다 — 키가 없거나 모델이 막힌 상황이면 `refresh()`
	 * 마다 같은 실패를 겪고, 그 사이 화면은 계속 "확인 중" 으로 보인다.
	 *
	 * 예전에는 boolean 이었고 **시도 직전에 무조건 세웠다.** 그래서 첫 시도가 실패하면 그 화면
	 * 에서는 다시 걸리지 않았다. 실패는 드물지 않다 — 방금 올린 표지가 KV 에 아직 퍼지지
	 * 않았거나(등록 직후가 바로 그 순간이다), 부모가 아직 AI 키를 넣지 않았을 수 있다.
	 * 그러면 부모가 "AI 로 책 정보 읽기" 를 눌러도 표지는 계속 누워 있었다.
	 */
	let coverFixAttempts = 0;
	/**
	 * 마지막으로 그린 데이터. 조회 없이 화면만 다시 그릴 때 쓴다.
	 *
	 * 선언은 반드시 첫 `refresh()` 보다 위에 둔다 — 아래에 두면 초기화 전에 읽혀 TDZ 로 터진다.
	 */
	let lastData = null;

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
		// 화면을 먼저 그리고 나서 표지를 손본다. 부모가 사진이 뜨기를 기다릴 이유가 없다.
		await fixCoverOrientation(data);
	}

	/**
	 * 표지가 누워 있으면 똑바로 세운다(§표지 방향).
	 *
	 * 두 쪽이 나눠 한다 — **판정은 서버만, 회전은 브라우저만** 할 수 있다. 프롬프트와 API Key 는
	 * 서버에 있고, Workers 런타임에는 이미지 디코더가 없다.
	 *
	 *   1. `coverRotation` 이 null 이면(= 아직 확인 안 한 책) 서버에 판정을 맡긴다
	 *   2. 각도가 0 이 아니면 사진을 받아 돌려서 다시 올린다
	 *   3. 서버가 남은 회전량을 0 으로 되돌린다 — 다음에 열 때는 아무 일도 일어나지 않는다
	 *
	 * 이미 등록해 둔 책도 이 길을 한 번 지나간다. 그래서 예전에 눕혀 올린 사진도 부모가 그 책을
	 * 열어 보는 순간 바로 선다.
	 */
	async function fixCoverOrientation(data) {
		if (!data) return;
		// 확인이 끝나고 똑바로 서 있는 책. 할 일이 없다.
		if (data.book.coverRotation === 0) return;
		if (coverFixAttempts >= MAX_COVER_FIX) return;
		coverFixAttempts++;

		let rotation = data.book.coverRotation;

		if (rotation === null) {
			coverFixing = "check";
			render(data);
			try {
				const relay = await usesBrowserRelay();
				({ rotation } = relay ? await orientCover(id) : await post(`/api/books/${id}/orient`));
			} catch {
				// 키가 없거나 모델이 응답하지 않는 경우. 표지는 그대로 두고 조용히 넘어간다 —
				// 부모가 하려던 일(분석·조사)을 이 실패로 막을 이유가 없다.
				coverFixing = null;
				render(data);
				return;
			}
		}

		if (!rotation) {
			coverFixing = null;
			render(data);
			return;
		}

		coverFixing = "turn";
		render(data);

		const turned = await rotateCover(data.book, rotation).catch(() => false);
		coverFixing = null;
		if (turned) await refresh();
		else render(data);
	}

	/** 저장된 표지를 받아 돌려서 같은 자리에 다시 올린다. 돌릴 수 없으면 false. */
	async function rotateCover(book, rotation) {
		const response = await fetch(book.coverUrl, { credentials: "same-origin" });
		if (!response.ok) return false;

		const rotated = await rotateImage(await response.blob(), rotation);
		// 브라우저가 디코딩하지 못한 경우다. 각도는 서버에 남아 있으니 다음에 다시 시도된다.
		if (!rotated) return false;

		const form = new FormData();
		form.append("cover", rotated, "cover.jpg");
		await upload(`/api/books/${id}/cover`, form, "PUT");
		return true;
	}

	function render(data) {
		if (data) lastData = data;
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
				infoCard(book, web),
				sourcesCard(sources, evidenceWeak, readyForQuiz),
				// AI 가 줄거리를 못 찾았거나 부모가 이미 적어 둔 경우에만 띄운다. 잘 된 책에는 군더더기다.
				!readyForQuiz || book.manualPlot ? plotCard(book, readyForQuiz) : null,
				attempts.length > 0 ? attemptsCard() : null,
				quizzes.length > 0 ? roundsCard() : null,
				quizCard(book, readyForQuiz, evidenceWeak),
				removeCard(book),
			].filter(Boolean),
		);
	}

	// 화살표 함수를 const 로 두면 render() 가 먼저 실행될 때 TDZ 에 걸린다. 선언식으로 둔다.
	function homeLink() {
		return el("a", { class: "btn btn--ghost", href: "/parent/books", "data-link": true, text: "← 책 목록" });
	}

	/**
	 * 이 책을 지우는 자리.
	 *
	 * **맨 아래에 따로 둔다.** 위쪽 버튼들 사이에 끼우면 "다시 분석하기" 를 누르려다 잘못
	 * 누를 수 있고, 이 조작은 되돌릴 수 없다. 무엇이 함께 사라지는지도 여기 적어 둔다 —
	 * 확인 창을 띄우기 전에 읽을 수 있어야 한다.
	 */
	function removeCard(book) {
		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: "이 책 삭제" }),
			// 자세한 내용은 확인 창이 다시 적는다. 여기서는 되돌릴 수 없다는 것만 알린다.
			el("p", { class: "hint", text: "이 책에 딸린 기록까지 함께 삭제합니다. 되돌릴 수 없습니다." }),
			el("button", {
				class: "btn btn--danger",
				type: "button",
				text: busy === "remove" ? "삭제 중…" : "책 삭제",
				disabled: busy !== null,
				onClick: () => removeBook(book),
			}),
		]);
	}

	/**
	 * 지운 뒤에는 **책장으로 돌아간다.** 없어진 책의 화면에 남아 있을 이유가 없다.
	 *
	 * 목록은 그 화면이 열릴 때 다시 조회하므로(`bookListPage`) 따로 갱신을 시키지 않는다.
	 */
	async function removeBook(book) {
		/*
		 * 확인 창을 띄우기 **전에** 표시를 세운다. 화면은 창이 뜨기 전 상태로 그려져 있어
		 * 버튼이 그대로 눌리고, 두 번 누르면 두 번째 요청이 404 를 받아 지우지도 못한 것처럼
		 * 보인다. 화면은 아직 다시 그리지 않는다 — 물어보는 중에 "삭제 중" 이라고 적으면 안 된다.
		 */
		if (busy !== null) return;
		busy = "remove";

		// 목록 화면과 같은 문구를 쓴다. 같은 일을 두 곳에서 다르게 설명하면 안 된다.
		const yes = await confirmDialog({
			title: `‘${book.title}’ 삭제`,
			message:
				"이 책의 정보와 참고 자료, 만들어 둔 문제와 아이의 도전 기록을 모두 삭제합니다. 되돌릴 수 없습니다.",
			confirmText: "삭제",
			cancelText: "취소",
		});
		if (!yes) {
			busy = null;
			return;
		}

		/*
		 * 화면만 다시 그린다. `refresh()` 를 부르면 곧 지울 책을 세 번 다시 조회하게 되고
		 * 그만큼 삭제가 늦어진다. 들고 있던 데이터로 그리면 버튼이 잠기고 표시가 바뀐다.
		 */
		render(lastData);

		try {
			await del(`/api/books/${id}`);
			await navigate("/parent/books");
			return;
		} catch (err) {
			message = err.message;
			messageKind = "error";
		}
		busy = null;
		await refresh();
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

		// 부모가 누르지 않은 일이 도는 중이다. 무엇을 하고 있는지 적어 준다.
		const fixing = coverFixing
			? el("p", {
					class: "hint",
					text:
						coverFixing === "check"
							? "표지 사진이 똑바로 서 있는지 확인하는 중입니다…"
							: "표지 사진을 똑바로 세우는 중입니다…",
				})
			: null;

		return el("section", { class: "card book-head" }, [
			el("img", { class: "book-cover", src: book.coverUrl, alt: `${book.title} 표지` }),
			el("div", { class: "book-head__body" }, [
				confidence,
				fixing,
				el("p", { class: "hint", text: book.analyzedAt ? "AI 분석 완료" : "아직 분석하지 않았습니다." }),
				el("button", {
					class: "btn btn--block",
					type: "button",
					text: busy === "analyze" ? "표지를 읽는 중…" : book.analyzedAt ? "다시 분석하기" : "AI 로 책 정보 읽기",
					disabled: busy !== null,
					onClick: () => {
						/*
						 * 방향 보정에 **새 기회를 준다.**
						 *
						 * 분석이 도는 것은 표지를 읽을 수 있고 AI 키도 살아 있다는 뜻이다. 화면을
						 * 열 때의 보정이 그 둘 때문에 실패했다면 지금은 될 가능성이 높다.
						 * `run` 이 끝에 `refresh()` 를 부르고, 그 안에서 다시 시도된다.
						 */
						coverFixAttempts = 0;
						return run(
							"analyze",
							(relay) => (relay ? identifyBook(id) : post(`/api/books/${id}/analyze`)),
							"표지에서 책 정보를 읽었습니다.",
						);
					},
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

		/*
		 * 짐작한 값은 **확인된 값과 다르게 보여야 한다.**
		 *
		 * 부모는 이 숫자로 아이에게 맞는 책인지 고른다. 웹에서 확인한 값과 모델이 짐작한
		 * 값이 똑같이 보이면, 짐작을 확인된 값으로 믿게 된다 — 그건 없는 것보다 나쁘다.
		 * 그래서 이름표를 달고 색도 달리한다.
		 */
		const guessed = level.source === "ai";

		return el("div", { class: "field" }, [
			el("div", { class: "level__head" }, [
				el("span", { class: "field__label", text: "읽기 난이도" }),
				guessed ? el("span", { class: "tag tag--warn", text: "AI가 추측한 등급" }) : null,
			]),
			el(
				"div",
				{ class: "row" },
				tags.map((text) => el("span", { class: `tag ${guessed ? "tag--guess" : "tag--ok"}`, text })),
			),
			el("p", {
				class: "hint",
				text: guessed
					? "웹에서 이 책의 등급을 찾지 못해 AI가 추측한 값이에요. 실제와 다를 수 있으니 arbookfind.com · lexile.com 에서 확인해 주세요."
					: "미국 학교에서 쓰는 척도예요. AR 4.7 은 4학년 7개월 수준을 뜻해요.",
			}),
		]);
	}

	/**
	 * 책 정보 — 부모가 고치고, 그 값으로 찾는다.
	 *
	 * **저장 버튼이 없다.** 고친 값을 저장하는 일과 그 값으로 찾는 일은 부모에게 한 동작이다.
	 * 버튼이 둘이면 저장을 잊고 찾기를 눌러 **고치기 전 값으로 검색**하는 일이 생긴다.
	 * 그래서 찾기 버튼이 저장까지 맡는다. 입력 칸에서 Enter 를 쳐도 같은 일이 일어난다.
	 */
	function infoCard(book, web) {
		const title = field("제목", { value: book.title, required: true });
		const author = field("지은이", { value: book.author ?? "" });
		const publisher = field("출판사", { value: book.publisher ?? "" });
		const isbn13 = field("ISBN", { value: book.isbn13 ?? book.isbn10 ?? "" });

		const form = el("form", { class: "card" }, [
			el("h2", { class: "section-title", text: "책 정보" }),
			el("p", {
				class: "hint",
				text: "AI 가 잘못 읽은 부분이 있으면 직접 고쳐 주세요. 고친 값을 저장하고 그 값으로 찾습니다.",
			}),
			title.wrap,
			author.wrap,
			publisher.wrap,
			isbn13.wrap,
			readingLevelBlock(book),
			// 크레딧은 이 버튼 오른쪽에 붙는다. 크레딧을 쓰는 버튼이 이것뿐이다.
			el("div", { class: "row row--baseline" }, [
				el("button", {
					class: "btn",
					type: "submit",
					text: busy === "search" ? "책 정보를 찾는 중…" : book.searchedAt ? "정보 다시 찾기" : "책 정보 찾기",
					disabled: busy !== null,
				}),
				creditRow(web),
			]),
		]);

		form.addEventListener("submit", (event) => {
			event.preventDefault();
			search();
		});

		/** 화면에 적힌 값을 저장하고 나서 찾는다. 저장이 실패하면 찾지 않는다. */
		function search() {
			return run(
				"search",
				async (relay) => {
					await patch(`/api/books/${id}`, {
						title: title.input.value,
						author: author.input.value,
						publisher: publisher.input.value,
						isbn13: isbn13.input.value,
					});
					return relay ? researchBook(id) : post(`/api/books/${id}/search`);
				},
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
			);
		}

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
	 * 이달 남은 웹 검색 크레딧. 찾기 버튼 오른쪽에 붙는다.
	 *
	 * **책당 검색 횟수는 적지 않는다.** 그것은 크레딧이 새지 않게 서버가 잡아 두는
	 * 안전장치일 뿐이고, 화면에 "이 책 0 / 6회 남음" 이라고 적어 두면 부모는 그 숫자를
	 * 아껴야 하는 것으로 읽고 다시 찾기를 망설인다 — 정작 다시 찾을수록 근거가 쌓인다.
	 *
	 * 크레딧은 다르다. 서비스 전체가 나눠 쓰는 이달 예산이라 보여 준다.
	 */
	function creditRow(web) {
		if (!web?.enabled) {
			return el("p", { class: "hint", text: "웹 검색 키가 없어 자료를 찾을 수 없습니다." });
		}

		const credits = web.creditsLeft ?? 0;
		const total = web.creditsTotal ?? 0;

		return el("p", {
			// 바닥나면 눈에 걸려야 한다. 넉넉할 때는 곁가지 정보로 조용히 둔다.
			class: credits < 3 ? "status status--warn" : "hint",
			text:
				`웹 검색 크레딧 ${credits}${total > 0 ? ` / ${total}` : ""} 남음` +
				// 잔량을 Tavily 에게 물어보지 못한 경우다. 우리 카운터로 짐작한 값이라고 밝힌다.
				(web.creditsMeasured === false ? " (짐작)" : ""),
		});
	}

	/**
	 * 참고 자료 한 건. 웹 검색은 묶어서 번호를 붙이므로 이름표 대신 도메인을 보여 준다.
	 *
	 * 스무 건이 한 줄씩 "웹 검색" 이라고 적혀 있으면 그 이름표는 아무것도 알려주지 않는다.
	 * 부모가 알고 싶은 것은 그게 어느 사이트인지다 — 서점인지 블로그인지 도서관인지.
	 */
	function sourceItem(source, { grouped = false } = {}) {
		return el("li", { class: "list__item list__item--stacked" }, [
			el("div", { class: "list__main" }, [
				el("span", { class: "list__title", text: source.title ?? source.url ?? "(제목 없음)" }),
				el("span", {
					class: source.source === "ai" ? "list__meta list__meta--weak" : "list__meta",
					text: grouped ? hostOf(source.url) : (SOURCE_LABEL[source.source] ?? source.source),
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
		]);
	}

	function sourcesCard(sources, evidenceWeak, readyForQuiz) {
		const status = !readyForQuiz
			? { kind: "warn", text: "자료는 찾았지만 줄거리를 얻지 못했습니다. 이 자료만으로는 문제를 만들 수 없습니다." }
			: evidenceWeak
				? { kind: "warn", text: "웹에서 찾은 근거가 2건 미만입니다. 문제는 만들 수 있지만 내용이 맞는지 더 꼼꼼히 확인해 주세요." }
				: { kind: "ok", text: "근거 자료가 충분합니다." };

		/*
		 * 웹 검색은 **한 영역으로 묶어 번호를 붙인다.**
		 *
		 * 서지 데이터베이스 자료는 한 곳에 한 건씩이라 어디서 왔는지가 곧 그 자료의 신원이다.
		 * 웹 검색은 여러 건이 한 덩어리로 오므로 하나하나에 "웹 검색" 이라고 적는 것은 같은 말을
		 * 되풀이하는 것이다. 번호를 붙이면 부모가 "세 번째 자료" 라고 짚어 말할 수 있다.
		 *
		 * 순서는 서버가 정한다(카카오 책 → 알라딘 → 웹 검색). 여기서 다시 정렬하지 않는다 —
		 * 순서를 정하는 곳이 둘이면 언젠가 서로 어긋난다.
		 */
		const verified = sources.filter((source) => source.source !== "web");
		const searched = sources.filter((source) => source.source === "web");

		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: `참고 자료 ${sources.length}건` }),
			el("p", { class: `status status--${status.kind}`, text: status.text }),
			sources.length === 0 ? el("p", { class: "hint", text: "아직 찾은 자료가 없습니다." }) : null,
			verified.length > 0 ? el("ul", { class: "list" }, verified.map((source) => sourceItem(source))) : null,
			searched.length > 0
				? el("div", { class: "source-group" }, [
						el("h3", { class: "section-subtitle", text: `웹 검색 ${searched.length}건` }),
						el(
							"ol",
							{ class: "list list--numbered" },
							searched.map((source) => sourceItem(source, { grouped: true })),
						),
					])
				: null,
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
				text: busy === "quiz" ? "퀴즈를 만드는 중…" : "문제 만들기",
				disabled: !readyForQuiz || busy !== null,
				/*
				 * **누르면 곧바로 검수 화면으로 넘어간다.**
				 *
				 * 예전에는 여기서 생성 시작까지 기다렸다. 그 사이 이 화면은 "퀴즈를 만드는
				 * 중입니다" 만 띄우고 서 있었고, 부모는 진행 상황을 볼 수 없었다 — 정작 그것을
				 * 보여 주는 화면이 다음 화면이다. 퀴즈 행을 만드는 왕복 하나만 기다리고 넘긴다.
				 *
				 * 생성을 시작하는 일은 넘어간 화면이 맡는다. 그래야 서버 경로든 브라우저
				 * 릴레이든 **자기에게 맞는 방식으로** 시작하고, 그 화면이 처음부터 진행을 그린다.
				 */
				onClick: async () => {
					busy = "quiz";
					const chosen = language.select.value;
					render(lastData);

					try {
						const { quiz } = await post("/api/quizzes", { bookId: book.id, language: chosen });
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
			kind === "plot" ? "저장하는 중입니다." : "잠시만 기다려 주세요. AI 가 작업 중입니다.";
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
