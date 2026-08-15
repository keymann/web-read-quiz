-- 0004_quiz_settings.sql — 출제 문항 수와 통과 기준을 부모가 정할 수 있게 한다
--
-- 요구사항은 20문제 중 10문제 통과를 기준으로 쓰지만(§17·§21.1), 아이의 학년과 책 분량에 따라
-- 부모가 조절할 수 있어야 한다는 요청에 따라 설정으로 뺀다. 기본값은 요구사항 그대로 20/10.
--
-- **퀴즈에도 같은 값을 복사해 둔다.** 설정을 나중에 바꿔도 이미 만들어진 퀴즈의 통과 기준이
-- 따라 바뀌면 안 된다. 과거 기록은 그때의 기준 그대로 읽혀야 한다(§21.7 의 정신).

ALTER TABLE parent_settings ADD COLUMN question_count INTEGER NOT NULL DEFAULT 20;
ALTER TABLE parent_settings ADD COLUMN pass_count     INTEGER NOT NULL DEFAULT 10;

ALTER TABLE quizzes ADD COLUMN question_count INTEGER NOT NULL DEFAULT 20;
ALTER TABLE quizzes ADD COLUMN pass_count     INTEGER NOT NULL DEFAULT 10;
