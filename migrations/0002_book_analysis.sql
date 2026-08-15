-- 0002_book_analysis.sql — 책 식별·검색 결과를 담을 컬럼 추가
--
-- Book Brief 는 문제 생성 프롬프트의 입력이 되는 정리된 텍스트다(docs/ai-question-generation.md 3단계).
-- 재도전마다 새 문제를 만들 때 1·2단계(Vision·웹검색)를 반복하지 않으려고 저장해 둔다.

ALTER TABLE books ADD COLUMN cover_mime TEXT;
ALTER TABLE books ADD COLUMN brief TEXT;
ALTER TABLE books ADD COLUMN analyzed_at TEXT;
ALTER TABLE books ADD COLUMN searched_at TEXT;
