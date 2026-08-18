import { requireParent } from "../auth/guards";
import * as booksRepo from "../repositories/books";
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

async function detail({ env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	const row = await book.requireOwned(env, parent.userId, params.id!);
	const sources = await booksRepo.listSources(env, row.id);

	return ok({
		book: book.toView(row),
		sources: sources.map((s) => ({ source: s.source, url: s.url, title: s.title, content: s.content })),
		// 판정 기준은 서비스 한 곳에만 둔다. 예전에는 여기와 search 결과가 서로 달라
		// "검색 직후엔 만들 수 있다더니 다시 열면 버튼이 잠기는" 일이 있었다.
		readyForQuiz: book.isReadyForQuiz(row.brief),
		evidenceWeak: book.hasWeakEvidence(book.evidenceCount(sources)),
		// 재검색 버튼이 남은 횟수를 보여줄 수 있게 함께 내린다. 크레딧을 쓰는 조작이므로
		// 누르기 전에 몇 번 남았는지 알아야 한다.
		web: {
			enabled: budget.slots(env).length > 0,
			searchesLeft: Math.max(0, budget.MAX_SEARCHES_PER_BOOK - row.web_searches),
			creditsLeft: await budget.remaining(env),
		},
	});
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

async function analyze({ env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	await rateLimit(env, "ai", parent.userId, 20, 60 * 60);
	return ok(await book.analyze(env, parent.userId, params.id!));
}

async function search({ env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	await rateLimit(env, "ai", parent.userId, 20, 60 * 60);
	return ok(await book.search(env, parent.userId, params.id!));
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
	if ("isbn13" in body) fields.isbn13 = v.optionalStr(body, "isbn13") || null;
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

/**
 * 부모가 누르는 웹 자료 재검색. **크레딧을 쓰는 유일한 사용자 조작**이다.
 *
 * `ai` 레이트리밋과 별도로 둔다 — 성격이 다르고, 책당 횟수와 월 예산이 이미 두 겹으로 막는다.
 */
async function webSearch({ env, principal, params }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	await rateLimit(env, "web-search", parent.userId, 30, 60 * 60);
	return ok(await book.refreshWeb(env, parent.userId, params.id!));
}

export const bookRoutes: Route[] = [
	route("POST", "/api/books", upload),
	route("PUT", "/api/books/:id/plot", manualPlot),
	route("GET", "/api/books", list),
	route("GET", "/api/books/:id", detail),
	route("PATCH", "/api/books/:id", patch),
	route("GET", "/api/books/:id/cover", cover),
	route("POST", "/api/books/:id/analyze", analyze),
	route("POST", "/api/books/:id/search", search),
	route("POST", "/api/books/:id/web-search", webSearch),
];
