-- 0007_question_language.sql — 문제를 어떤 언어로 낼지 고른다
--
-- 책은 한국어라도 문제는 영어로 내고 싶을 수 있다(영어 독해 겸용). 부모가 기본값을 정해 두고,
-- 퀴즈를 만들 때 그 판만 바꿀 수도 있어야 한다.
--
-- 퀴즈에도 복사해 둔다. 나중에 기본값을 바꿔도 이미 만든 퀴즈의 언어는 그대로여야 하고,
-- 부족한 문항을 채울 때 그 퀴즈가 쓰던 언어를 그대로 이어야 하기 때문이다.
-- (question_count · pass_count 와 같은 이유다)

ALTER TABLE parent_settings ADD COLUMN question_language TEXT NOT NULL DEFAULT 'en'
	CHECK (question_language IN ('en','ko'));

ALTER TABLE quizzes ADD COLUMN language TEXT NOT NULL DEFAULT 'en'
	CHECK (language IN ('en','ko'));
