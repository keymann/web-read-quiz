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
	cover_r2_key: string | null;
	cover_mime: string | null;
	description: string | null;
	published_at: string | null;
	ai_extracted: string | null;
	ai_confidence: number | null;
	brief: string | null;
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
	created_at: string;
}

export async function insert(
	env: AppEnv,
	book: { id: string; createdBy: string; title: string; coverR2Key: string; coverMime: string },
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO books (id, created_by, title, cover_r2_key, cover_mime)
		 VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(book.id, book.createdBy, book.title, book.coverR2Key, book.coverMime)
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
	ai_extracted?: string | null;
	ai_confidence?: number | null;
	brief?: string | null;
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

export async function listSources(env: AppEnv, bookId: string): Promise<BookSourceRow[]> {
	const { results } = await env.DB.prepare(
		"SELECT * FROM book_sources WHERE book_id = ? ORDER BY created_at",
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

	for (const source of sources) {
		statements.push(
			env.DB.prepare(
				`INSERT INTO book_sources (id, book_id, source, url, title, content)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			).bind(source.id, source.bookId, source.source, source.url, source.title, source.content),
		);
	}

	await env.DB.batch(statements);
}
