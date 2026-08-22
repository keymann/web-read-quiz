import type { AppEnv } from "../types";

/**
 * `books` · `book_sources` 접근.
 * 모든 조회에 `created_by` 를 넣어 남의 책이 나오지 않게 한다(§21.5).
 */

export interface BookRow {
	id: string;
	created_by: string;
	title: string;
	subtitle: string | null;
	author: string | null;
	publisher: string | null;
	isbn10: string | null;
	isbn13: string | null;
	cover_image_url: string | null;
	cover_key: string | null;
	cover_mime: string | null;
	/**
	 * 표지를 똑바로 세우기까지 **아직 남은 회전량**(시계 방향, 도).
	 * `null` 은 아직 확인하지 않은 것, `0` 은 똑바로 서 있는 것이다.
	 */
	cover_rotation: number | null;
	description: string | null;
	published_at: string | null;
	ai_extracted: string | null;
	ai_confidence: number | null;
	brief: string | null;
	/** 부모가 직접 적은 줄거리. AI 가 모르는 책의 유일한 입력이다. */
	manual_plot: string | null;
	/** 이번 조사에서 받은 서지 결과(JSON 배열). 프롬프트와 병합이 같은 값을 쓰게 한다. */
	bib_cache: string | null;
	/** Tavily 웹 검색 결과(JSON 배열). 재조사·재도전이 크레딧을 다시 쓰지 않게 한다. */
	web_cache: string | null;
	/** 이 책이 웹 검색을 쓴 횟수. 책당 상한을 건다. */
	web_searches: number;
	/**
	 * 웹 자료를 마지막으로 찾은 시각.
	 *
	 * `searched_at` 과 견주어 **이번 조사에서 이미 찾았는지**를 가린다. 한 번의 조사 안에서
	 * 조사 계획을 여러 번 세우는 경로가 있어(모델 교체·내장 검색 429) 그때마다 검색하면
	 * 부모가 버튼을 한 번 눌렀는데 크레딧이 두세 번 나간다.
	 */
	web_searched_at: string | null;
	/** 책이 쓰인 언어(ISO 639-1). 퀴즈의 `language`(문제를 낼 말)와 다르다. */
	book_language: string | null;
	/* 영문책의 읽기 난이도. 한국어 책에는 매겨지지 않아 늘 null 이다. */
	ar_level: number | null;
	ar_points: number | null;
	ar_interest: string | null;
	lexile: string | null;
	/** 등급을 찾아본 적이 있는지. 못 찾은 책에서 같은 검색을 되풀이하지 않기 위한 표시. */
	reading_level_searched_at: string | null;
	/** 등급이 어디서 왔는지. `web` = 실제 페이지에서 읽음, `ai` = 모델이 짐작함. */
	reading_level_source: "web" | "ai" | null;
	analyzed_at: string | null;
	searched_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface BookSourceRow {
	id: string;
	book_id: string;
	source: string;
	url: string | null;
	title: string | null;
	content: string | null;
	/** 화면에 늘어놓을 순서. 넣는 쪽이 정한다(카카오 책 → 알라딘 → 웹 검색). */
	position: number;
	created_at: string;
}

export async function insert(
	env: AppEnv,
	book: { id: string; createdBy: string; title: string; coverKey: string; coverMime: string },
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO books (id, created_by, title, cover_key, cover_mime)
		 VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(book.id, book.createdBy, book.title, book.coverKey, book.coverMime)
		.run();
}

export async function findOwned(
	env: AppEnv,
	userId: string,
	bookId: string,
): Promise<BookRow | null> {
	return env.DB.prepare("SELECT * FROM books WHERE id = ? AND created_by = ?")
		.bind(bookId, userId)
		.first<BookRow>();
}

export async function listByUser(env: AppEnv, userId: string): Promise<BookRow[]> {
	const { results } = await env.DB.prepare(
		"SELECT * FROM books WHERE created_by = ? ORDER BY created_at DESC LIMIT 100",
	)
		.bind(userId)
		.all<BookRow>();
	return results;
}

export interface BookFields {
	title?: string;
	subtitle?: string | null;
	author?: string | null;
	publisher?: string | null;
	isbn10?: string | null;
	isbn13?: string | null;
	description?: string | null;
	published_at?: string | null;
	cover_key?: string;
	cover_mime?: string;
	cover_rotation?: number | null;
	ai_extracted?: string | null;
	ai_confidence?: number | null;
	brief?: string | null;
	manual_plot?: string | null;
	bib_cache?: string | null;
	web_cache?: string | null;
	web_searches?: number;
	web_searched_at?: string | null;
	book_language?: string | null;
	ar_level?: number | null;
	ar_points?: number | null;
	ar_interest?: string | null;
	lexile?: string | null;
	reading_level_searched_at?: string | null;
	reading_level_source?: "web" | "ai" | null;
	analyzed_at?: string | null;
	searched_at?: string | null;
}

/** 넘어온 필드만 갱신한다. 컬럼 이름은 코드 안의 리터럴에서만 오고 값은 전부 바인딩된다. */
export async function update(
	env: AppEnv,
	userId: string,
	bookId: string,
	fields: BookFields,
): Promise<void> {
	const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
	if (entries.length === 0) return;

	const sets = entries.map(([column]) => `${column} = ?`);
	sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");

	await env.DB.prepare(`UPDATE books SET ${sets.join(", ")} WHERE id = ? AND created_by = ?`)
		.bind(...entries.map(([, value]) => value as string | number | null), bookId, userId)
		.run();
}

/**
 * 등급 검색을 맡는다. **먼저 표시를 세운 쪽만** 실제로 찾아 나선다.
 *
 * 조사 준비 단계와 반영 단계가 동시에 같은 책을 찾는 일이 있다. 표시를 검색 뒤에 세우면
 * 둘 다 통과해 크레딧을 두 번 쓴다. `claimForGeneration` 과 같은 방식으로, 조건과 갱신을
 * 한 문장에 두어 하나만 통과하게 한다.
 */
export async function claimReadingLevelSearch(
	env: AppEnv,
	userId: string,
	bookId: string,
): Promise<boolean> {
	const result = await env.DB.prepare(
		`UPDATE books
		    SET reading_level_searched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
		        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		  WHERE id = ? AND created_by = ? AND reading_level_searched_at IS NULL`,
	)
		.bind(bookId, userId)
		.run();

	return (result.meta.changes ?? 0) > 0;
}

export async function listSources(env: AppEnv, bookId: string): Promise<BookSourceRow[]> {
	// `position` 이 없던 옛 행은 모두 0 이라 그때는 `created_at` 이 순서를 정한다.
	const { results } = await env.DB.prepare(
		"SELECT * FROM book_sources WHERE book_id = ? ORDER BY position, created_at",
	)
		.bind(bookId)
		.all<BookSourceRow>();
	return results;
}

export interface NewSource {
	id: string;
	bookId: string;
	source: string;
	url: string | null;
	title: string | null;
	content: string | null;
}

/** 검색을 다시 돌리면 이전 출처를 지우고 새로 쌓는다. 오래된 근거가 섞이지 않게 한다. */
export async function replaceSources(
	env: AppEnv,
	bookId: string,
	sources: NewSource[],
): Promise<void> {
	const statements = [env.DB.prepare("DELETE FROM book_sources WHERE book_id = ?").bind(bookId)];

	// 넘어온 배열의 순서가 그대로 화면 순서가 된다. 정렬은 부르는 쪽(`services/book.ts`)이 한다.
	sources.forEach((source, position) => {
		statements.push(
			env.DB.prepare(
				`INSERT INTO book_sources (id, book_id, source, url, title, content, position)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).bind(
				source.id,
				source.bookId,
				source.source,
				source.url,
				source.title,
				source.content,
				position,
			),
		);
	});

	await env.DB.batch(statements);
}

/**
 * 책과 그 책에서 나온 **모든 기록**을 지운다.
 *
 * 스키마에 `ON DELETE CASCADE` 가 걸려 있지만 여기서 순서대로 직접 지운다. 외래키 강제가
 * 켜져 있느냐에 기대지 않아도 되고, **무엇이 함께 사라지는지가 코드에 적혀 있어야** 부모에게
 * 무엇을 지운다고 알릴지도 한 곳에서 정할 수 있다.
 *
 * 한 `batch` 로 보내므로 왕복은 한 번이고, 중간에 실패하면 전부 되돌아간다.
 * 소유 확인은 부르는 쪽(`services/book.ts`)이 먼저 하지만 마지막 문장에도 `created_by` 를
 * 넣는다 — 남의 책이 지워지는 일은 어느 층에서도 막아야 한다(§21.5).
 */
export async function remove(env: AppEnv, userId: string, bookId: string): Promise<boolean> {
	const quizIds = "SELECT id FROM quizzes WHERE book_id = ?";
	const questionIds = `SELECT id FROM questions WHERE quiz_id IN (${quizIds})`;
	const attemptIds = `SELECT id FROM quiz_attempts WHERE quiz_id IN (${quizIds})`;

	// 자식 → 부모 순서. 각 문장의 `?` 는 하나뿐이라 모두 같은 값을 바인딩한다.
	const cascade = [
		`DELETE FROM question_answers WHERE attempt_id IN (${attemptIds})`,
		`DELETE FROM attempt_questions WHERE attempt_id IN (${attemptIds})`,
		`DELETE FROM quiz_attempts WHERE quiz_id IN (${quizIds})`,
		`DELETE FROM quiz_assignments WHERE quiz_id IN (${quizIds})`,
		`DELETE FROM question_validations WHERE question_id IN (${questionIds})`,
		`DELETE FROM question_histories WHERE question_id IN (${questionIds})`,
		`DELETE FROM question_versions WHERE question_id IN (${questionIds})`,
		`DELETE FROM questions WHERE quiz_id IN (${quizIds})`,
		`DELETE FROM quizzes WHERE book_id = ?`,
		`DELETE FROM book_sources WHERE book_id = ?`,
	];

	const results = await env.DB.batch([
		...cascade.map((sql) => env.DB.prepare(sql).bind(bookId)),
		env.DB.prepare("DELETE FROM books WHERE id = ? AND created_by = ?").bind(bookId, userId),
	]);

	// 마지막 문장이 책 행이다. 그것이 지워졌을 때만 삭제로 본다.
	return (results[results.length - 1]?.meta.changes ?? 0) > 0;
}
