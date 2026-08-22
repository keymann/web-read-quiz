import { requireParent } from "../auth/guards";
import * as booksRepo from "../repositories/books";
import * as bibliographic from "../search/bibliographic";
import * as book from "../services/book";
import * as budget from "../services/search-budget";
import { MAX_BYTES } from "../utils/image";
import { rateLimit } from "../utils/ratelimit";
import { invalid, ok } from "../utils/response";
import * as v from "../utils/validate";
import { route, type Route, type RouteCtx } from "./router";

async function upload({ request, env, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	await rateLimit(env, "book-upload", parent.userId, 20, 60 * 60);

	// Content-Length 로 먼저 걸러 큰 파일을 메모리에 올리지 않는다.
	const declared = Number(request.headers.get("Content-Length") ?? "0");
	if (declared > MAX_BYTES * 1.1) throw invalid("이미지가 너무 큽니다.");

	const form = await request.formData();
	const file = form.get("cover");
	if (!(file instanceof File)) throw invalid("표지 이미지를 선택해 주세요.");

	const bytes = new Uint8Array(await file.arrayBuffer());
	return ok({ book: await book.create(env, parent.userId, bytes) }, 201);
}

async function list({ env, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	const rows = await booksRepo.listByUser(env, parent.userId);
	return ok({ books: rows.map(book.toView) });
}

async function detail({ env, ctx, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	const row = await book.requireOwned(env, parent.userId, params.id!);
	const sources = await booksRepo.listSources(env, row.id);

	/*
	 * 잔량은 우리 카운터가 아니라 **Tavily 가 아는 값**이다. 다만 물어보는 데 실측 1.5초가
	 * 걸려서, 들고 있던 값을 바로 내주고 갱신은 응답 뒤로 맡긴다. 이 화면이 느려질 이유가 없다.
	 */
	const credits = await budget.usage(env);
	if (credits.stale) {
		ctx.waitUntil(
			budget.refreshUsage(env).catch((err: unknown) => {
				console.warn("tavily usage lookup failed", err);
			}),
		);
	}

	return ok({
		book: book.toView(row),
		sources: sources.map((s) => ({ source: s.source, url: s.url, title: s.title, content: s.content })),
		// 판정 기준은 서비스 한 곳에만 둔다. 예전에는 여기와 search 결과가 서로 달라
		// "검색 직후엔 만들 수 있다더니 다시 열면 버튼이 잠기는" 일이 있었다.
		readyForQuiz: book.isReadyForQuiz(row.brief),
		evidenceWeak: book.hasWeakEvidence(book.evidenceCount(sources)),
		// 재검색 버튼이 남은 횟수를 보여줄 수 있게 함께 내린다. 크레딧을 쓰는 조작이므로
		// 누르기 전에 몇 번 남았는지 알아야 한다.
		/*
		 * 책당 웹 검색 횟수(`web_searches`)는 **내려보내지 않는다.**
		 *
		 * 그것은 크레딧이 새지 않게 서버가 잡아 두는 안전장치이고, 부모가 조작할 것이 없다.
		 * 화면에 "이 책 0 / 6회 남음" 이라고 적어 두면 부모는 그 숫자를 아껴야 하는 것으로
		 * 읽고 다시 찾기를 망설인다 — 정작 다시 찾을수록 근거가 쌓이는데 그 반대로 이끈다.
		 *
		 * 크레딧은 다르다. 서비스 전체가 나눠 쓰는 이달 예산이라 보여 준다.
		 */
		web: {
			enabled: budget.slots(env).length > 0,
			// 남은 크레딧만 보여 주면 그것이 많은 수인지 적은 수인지 알 수 없다. 한도를
			// 함께 내려 화면이 "3899 / 4000 남음" 으로 적을 수 있게 한다.
			creditsLeft: Math.max(0, credits.limit - credits.used),
			creditsTotal: credits.limit,
			// Tavily 에게 물어 얻은 값인지. 짐작이면 화면이 그렇게 적는다.
			creditsMeasured: credits.measured,
		},
	});
}

/**
 * 브라우저가 돌려 준 표지로 갈아 끼운다(§표지 방향).
 *
 * 회전은 브라우저만 할 수 있다 — Workers 런타임에는 이미지 디코더가 없다. 그래서 서버는
 * 각도를 판정해 적어 두고(`POST :id/orient`), 실제 회전과 재업로드는 브라우저가 한다.
 *
 * 등록과 같은 검증을 거친다. 클라이언트가 보낸 바이트를 그대로 믿지 않는다(§26).
 */
async function replaceCover({ request, env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	await rateLimit(env, "book-upload", parent.userId, 20, 60 * 60);

	const declared = Number(request.headers.get("Content-Length") ?? "0");
	if (declared > MAX_BYTES * 1.1) throw invalid("이미지가 너무 큽니다.");

	const form = await request.formData();
	const file = form.get("cover");
	if (!(file instanceof File)) throw invalid("표지 이미지를 선택해 주세요.");

	const bytes = new Uint8Array(await file.arrayBuffer());
	return ok({ book: await book.replaceCover(env, parent.userId, params.id!, bytes) });
}

/** 표지 이미지는 비공개 KV 에 있다. 소유권을 확인하고 Worker 가 대신 내보낸다. */
async function cover({ env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	const { body, mime } = await book.readCover(env, parent.userId, params.id!);

	return new Response(body, {
		headers: {
			"Content-Type": mime,
			// 본인만 볼 수 있는 이미지이므로 공용 캐시에 남기지 않는다.
			"Cache-Control": "private, max-age=3600",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

/**
 * 표지가 누워 있는지 확인한다.
 *
 * 책 한 권에 한 번만 부르는 호출이라 `ai` 레이트리밋과 따로 둔다. 부모가 책 화면을 열 때
 * 화면이 알아서 부르므로, 분석·조사와 같은 통에 넣으면 책을 몇 권 열어 보다가 정작 분석을
 * 못 하게 된다.
 */
async function orient({ env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	await rateLimit(env, "cover-orient", parent.userId, 60, 60 * 60);
	return ok(await book.orient(env, parent.userId, params.id!));
}

async function analyze({ env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	await rateLimit(env, "ai", parent.userId, 20, 60 * 60);
	return ok(await book.analyze(env, parent.userId, params.id!));
}

/**
 * 책 정보 찾기. **크레딧을 쓰는 유일한 사용자 조작**이다.
 *
 * 예전에는 웹 자료 재검색이 따로 있었다. 버튼을 하나로 합치면서 이 호출이 웹 검색까지
 * 맡는다 — 부모가 "정보 다시 찾기" 를 누르면 질의 사다리가 한 칸 올라간다.
 *
 * 크레딧은 책당 횟수(`MAX_SEARCHES_PER_BOOK`)와 월 예산(`MONTHLY_CAP`)이 두 겹으로 막고,
 * 이 레이트리밋은 AI 호출을 막는 몫이다.
 */
async function search({ env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	await rateLimit(env, "ai", parent.userId, 20, 60 * 60);
	return ok(await book.search(env, parent.userId, params.id!));
}

/**
 * 책을 지운다. **그 책에서 나온 기록까지 함께 사라진다.**
 *
 * 무엇이 사라지는지는 서비스·리포지토리가 정하고, 여기서는 소유 확인만 거쳐 넘긴다.
 * 되돌릴 수 없는 조작이므로 화면이 먼저 부모에게 알리고 확인을 받는다.
 */
async function remove({ env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	await book.remove(env, parent.userId, params.id!);
	return ok({ deleted: true });
}

/**
 * 화면의 ISBN 칸 하나를 **자릿수에 맞는 컬럼**으로 보낸다.
 *
 * 화면에는 ISBN 칸이 하나뿐인데(`isbn13 ?? isbn10`) 컬럼은 둘이다. 예전에는 그 값을 늘
 * `isbn13` 에 넣었다. 그러면 10자리만 있는 책에서 그 값이 `isbn13` 칸으로 옮겨 앉는다 —
 * 찾기 버튼이 저장까지 맡게 되면서 이 일이 누를 때마다 일어나게 되어 자릿수로 가른다.
 *
 * `applyIdentity` 가 AI 응답을 넣을 때와 같은 규칙이다.
 */
function isbnFields(raw: string): booksRepo.BookFields {
	const isbn = bibliographic.normalizeIsbn(raw);
	// 비우면 둘 다 지운다. 한쪽만 지우면 화면이 다른 쪽 값을 다시 보여 준다.
	if (isbn === "") return { isbn13: null, isbn10: null };
	if (!bibliographic.isValidIsbn(isbn)) throw invalid("ISBN 은 10자리 또는 13자리입니다.");
	return isbn.length === 13 ? { isbn13: isbn } : { isbn13: null, isbn10: isbn };
}

/** AI 오인식 보정. 부모가 고친 값은 이후 검색·문제 생성의 입력이 된다. */
async function patch({ request, env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	await book.requireOwned(env, parent.userId, params.id!);

	const body = await v.readJson(request);
	const fields: booksRepo.BookFields = {};

	if ("title" in body) fields.title = v.str(body, "title", "제목");
	if ("author" in body) fields.author = v.optionalStr(body, "author") || null;
	if ("publisher" in body) fields.publisher = v.optionalStr(body, "publisher") || null;
	if ("isbn13" in body) Object.assign(fields, isbnFields(v.optionalStr(body, "isbn13") ?? ""));
	if ("description" in body) fields.description = v.optionalStr(body, "description") || null;

	if (Object.keys(fields).length === 0) throw invalid("변경할 내용이 없습니다.");

	await booksRepo.update(env, parent.userId, params.id!, fields);
	return ok({ book: book.toView(await book.requireOwned(env, parent.userId, params.id!)) });
}

/**
 * 부모가 직접 적은 줄거리. AI 호출이 없으므로 `ai` 레이트리밋을 쓰지 않는다.
 *
 * PATCH 에 필드 하나를 더하지 않고 따로 둔 이유: 이 요청만 Brief 를 다시 조립한다.
 * 오탈자 고치는 PATCH 와 같은 문으로 들어오면 그 부수효과가 안 보인다.
 */
async function manualPlot({ request, env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	const body = await v.readJson(request);
	// 길이 판정은 서비스가 한다. 최소 길이와 함께 한 곳에서 정해야 메시지가 갈리지 않는다.
	return ok(await book.saveManualPlot(env, parent.userId, params.id!, v.optionalStr(body, "plot") ?? ""));
}

export const bookRoutes: Route[] = [
	route("POST", "/api/books", upload),
	route("PUT", "/api/books/:id/plot", manualPlot),
	route("GET", "/api/books", list),
	route("GET", "/api/books/:id", detail),
	route("PATCH", "/api/books/:id", patch),
	route("DELETE", "/api/books/:id", remove),
	route("GET", "/api/books/:id/cover", cover),
	route("PUT", "/api/books/:id/cover", replaceCover),
	route("POST", "/api/books/:id/orient", orient),
	route("POST", "/api/books/:id/analyze", analyze),
	route("POST", "/api/books/:id/search", search),
];
