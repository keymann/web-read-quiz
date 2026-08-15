-- 0001_initial.sql — AI 독서 퀴즈 초기 스키마
--
-- 설계 원칙
--  * 시간은 모두 ISO8601 UTC 문자열(TEXT). `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
--  * 과거 풀이 기록은 절대 변하지 않는다. 문제 본문은 `question_versions` 에 버전으로 쌓고,
--    Attempt 는 그 시점의 version id 를 `attempt_questions` 로 고정한다. (요구사항 §22 방법 A)
--  * 권한 검증에 필요한 소유 관계(parent_user_id / child_id)를 각 테이블에 직접 들고 있어
--    조인 없이도 단일 WHERE 로 소유권을 강제할 수 있게 한다.

PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────────────────────
-- 계정
-- ─────────────────────────────────────────────────────────────

-- 로그인 가능한 모든 계정(부모/아이). 아이도 직접 로그인하므로 같은 테이블에 둔다.
CREATE TABLE users (
	id            TEXT PRIMARY KEY,
	login_id      TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	role          TEXT NOT NULL CHECK (role IN ('PARENT', 'CHILD')),
	display_name  TEXT NOT NULL,
	-- 비활성 계정은 로그인할 수 없다. 과거 풀이 기록을 지우지 않기 위해 행은 남긴다.
	is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
	created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 부모가 관리하는 아이 프로필. child_user_id 는 아이의 로그인 계정(users.role='CHILD').
CREATE TABLE children (
	id             TEXT PRIMARY KEY,
	parent_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	child_user_id  TEXT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
	name           TEXT NOT NULL,
	grade          INTEGER CHECK (grade IS NULL OR grade BETWEEN 1 AND 6),
	is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
	created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_children_parent ON children(parent_user_id, is_active);

-- 부모별 설정. OPENAI_API_KEY 는 평문 저장하지 않고 AES-GCM 으로 암호화해서 보관한다.
CREATE TABLE parent_settings (
	user_id                  TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	openai_api_key_cipher    TEXT,
	openai_api_key_iv        TEXT,
	openai_api_key_last4     TEXT,
	openai_model             TEXT,
	openai_vision_model      TEXT,
	created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ─────────────────────────────────────────────────────────────
-- 책
-- ─────────────────────────────────────────────────────────────

CREATE TABLE books (
	id               TEXT PRIMARY KEY,
	created_by       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	title            TEXT NOT NULL,
	subtitle         TEXT,
	author           TEXT,
	publisher        TEXT,
	isbn10           TEXT,
	isbn13           TEXT,
	cover_image_url  TEXT,
	cover_r2_key     TEXT,
	description      TEXT,
	published_at     TEXT,
	-- AI Vision 이 표지에서 추출한 원본 결과와 신뢰도(외부 검색 결과와 구분해 보관, §6)
	ai_extracted     TEXT,
	ai_confidence    REAL,
	created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_books_created_by ON books(created_by);
CREATE INDEX idx_books_isbn13 ON books(isbn13);

-- 웹 검색으로 수집한 책 정보의 출처. 원문 전체가 아니라 공개 요약/서평 발췌만 저장한다(§6).
CREATE TABLE book_sources (
	id         TEXT PRIMARY KEY,
	book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
	source     TEXT NOT NULL,
	url        TEXT,
	title      TEXT,
	content    TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_book_sources_book ON book_sources(book_id);

-- ─────────────────────────────────────────────────────────────
-- 퀴즈 / 문제
-- ─────────────────────────────────────────────────────────────

CREATE TABLE quizzes (
	id             TEXT PRIMARY KEY,
	book_id        TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
	parent_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	status         TEXT NOT NULL DEFAULT 'DRAFT'
	               CHECK (status IN ('DRAFT','GENERATING','REVIEW','APPROVED','ASSIGNED','IN_PROGRESS','COMPLETED')),
	-- 재도전용으로 같은 책에 대해 여러 회차의 퀴즈가 생성된다(§18).
	round          INTEGER NOT NULL DEFAULT 1,
	generation_error TEXT,
	created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_quizzes_parent ON quizzes(parent_user_id);
CREATE INDEX idx_quizzes_book ON quizzes(book_id);

-- 문제의 "현재 상태". 본문은 question_versions 에 버전으로 쌓이고 여기에는 최신 버전을 캐시한다.
CREATE TABLE questions (
	id               TEXT PRIMARY KEY,
	quiz_id          TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
	question_number  INTEGER NOT NULL,
	question_text    TEXT NOT NULL,
	choice1          TEXT NOT NULL,
	choice2          TEXT NOT NULL,
	choice3          TEXT NOT NULL,
	choice4          TEXT NOT NULL,
	correct_choice   INTEGER NOT NULL CHECK (correct_choice BETWEEN 1 AND 4),
	question_type    TEXT NOT NULL CHECK (question_type IN
	                 ('EVENT','CHARACTER','DETAIL','SEQUENCE','CAUSE_EFFECT','ACTION','EMOTION','INFERENCE')),
	difficulty       INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 3),
	explanation      TEXT,
	evidence         TEXT,
	read_required    INTEGER NOT NULL DEFAULT 1 CHECK (read_required IN (0,1)),
	-- 부모가 삭제하면 행을 지우지 않고 비활성화한다(과거 기록 보존, §21.7·§21.8).
	is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
	current_version  INTEGER NOT NULL DEFAULT 1,
	created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_questions_quiz ON questions(quiz_id);
-- 활성 문제 안에서 번호는 유일해야 한다(퀴즈당 정확히 20문항, §21.1).
CREATE UNIQUE INDEX idx_questions_quiz_number_active
	ON questions(quiz_id, question_number) WHERE is_active = 1;

-- 문제 본문의 불변 스냅샷. Attempt 는 여기를 가리키므로 이후 수정에 영향받지 않는다(§22).
CREATE TABLE question_versions (
	id              TEXT PRIMARY KEY,
	question_id     TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
	version         INTEGER NOT NULL,
	question_text   TEXT NOT NULL,
	choice1         TEXT NOT NULL,
	choice2         TEXT NOT NULL,
	choice3         TEXT NOT NULL,
	choice4         TEXT NOT NULL,
	correct_choice  INTEGER NOT NULL CHECK (correct_choice BETWEEN 1 AND 4),
	question_type   TEXT NOT NULL,
	difficulty      INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 3),
	explanation     TEXT,
	evidence        TEXT,
	read_required   INTEGER NOT NULL DEFAULT 1 CHECK (read_required IN (0,1)),
	created_by      TEXT NOT NULL CHECK (created_by IN ('AI','PARENT')),
	created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_question_versions_unique ON question_versions(question_id, version);

-- 누가 언제 무엇을 바꿨는지의 감사 로그(§12).
CREATE TABLE question_histories (
	id          TEXT PRIMARY KEY,
	question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
	action      TEXT NOT NULL CHECK (action IN
	            ('AI_GENERATED','AI_REGENERATED','PARENT_EDITED','PARENT_DELETED','PARENT_APPROVED')),
	old_data    TEXT,
	new_data    TEXT,
	actor_type  TEXT NOT NULL CHECK (actor_type IN ('AI','PARENT')),
	actor_id    TEXT,
	created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_question_histories_question ON question_histories(question_id);

-- AI 검증 결과 기록. 실패 문제만 재생성하기 위해 문제 단위로 남긴다(§10·§28).
CREATE TABLE question_validations (
	id                  TEXT PRIMARY KEY,
	question_id         TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
	question_version_id TEXT NOT NULL REFERENCES question_versions(id) ON DELETE CASCADE,
	valid               INTEGER NOT NULL CHECK (valid IN (0,1)),
	score               INTEGER,
	reason              TEXT,
	read_required       INTEGER CHECK (read_required IN (0,1)),
	created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_question_validations_question ON question_validations(question_id);

-- ─────────────────────────────────────────────────────────────
-- 제출 / 풀이
-- ─────────────────────────────────────────────────────────────

CREATE TABLE quiz_assignments (
	id             TEXT PRIMARY KEY,
	quiz_id        TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
	parent_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	child_id       TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
	status         TEXT NOT NULL DEFAULT 'ASSIGNED'
	               CHECK (status IN ('ASSIGNED','IN_PROGRESS','COMPLETED')),
	assigned_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	started_at     TEXT,
	completed_at   TEXT
);
CREATE INDEX idx_assignments_child ON quiz_assignments(child_id, status);
CREATE INDEX idx_assignments_quiz ON quiz_assignments(quiz_id);

CREATE TABLE quiz_attempts (
	id            TEXT PRIMARY KEY,
	assignment_id TEXT NOT NULL REFERENCES quiz_assignments(id) ON DELETE CASCADE,
	quiz_id       TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
	child_id      TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
	attempt_no    INTEGER NOT NULL DEFAULT 1,
	started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	completed_at  TEXT,
	correct_count INTEGER NOT NULL DEFAULT 0,
	wrong_count   INTEGER NOT NULL DEFAULT 0,
	score         INTEGER NOT NULL DEFAULT 0,
	passed        INTEGER NOT NULL DEFAULT 0 CHECK (passed IN (0,1)),
	created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_attempts_child ON quiz_attempts(child_id, created_at);
CREATE INDEX idx_attempts_assignment ON quiz_attempts(assignment_id);

-- Attempt 시작 시점에 출제된 20문항을 버전 단위로 고정한다. 이후 문제가 수정/삭제돼도 불변.
CREATE TABLE attempt_questions (
	id                  TEXT PRIMARY KEY,
	attempt_id          TEXT NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
	question_id         TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
	question_version_id TEXT NOT NULL REFERENCES question_versions(id) ON DELETE CASCADE,
	question_number     INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_attempt_questions_unique ON attempt_questions(attempt_id, question_number);

CREATE TABLE question_answers (
	id                  TEXT PRIMARY KEY,
	attempt_id          TEXT NOT NULL REFERENCES quiz_attempts(id) ON DELETE CASCADE,
	question_id         TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
	question_version_id TEXT NOT NULL REFERENCES question_versions(id) ON DELETE CASCADE,
	selected_choice     INTEGER NOT NULL CHECK (selected_choice BETWEEN 1 AND 4),
	correct_choice      INTEGER NOT NULL CHECK (correct_choice BETWEEN 1 AND 4),
	is_correct          INTEGER NOT NULL CHECK (is_correct IN (0,1)),
	answered_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- 한 Attempt 안에서 같은 문제를 두 번 답할 수 없다(§15 "문제를 다시 풀 수는 없다").
CREATE UNIQUE INDEX idx_question_answers_unique ON question_answers(attempt_id, question_id);
