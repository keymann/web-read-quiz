-- Tavily 웹 검색 결과와 사용 횟수 (§docs/tavily-search-plan.md).
--
-- web_cache: 검색 결과(JSON 배열). bib_cache 와 같은 취지 — 준비 단계가 받은 것을 반영
--   단계가 그대로 읽어야 프롬프트가 본 자료와 저장되는 출처가 같아진다. 그리고 재도전
--   회차·정보 다시 찾기가 크레딧을 다시 쓰지 않는다. 아이가 5번 재도전해도 책은 그대로다.
--
-- web_searches: 이 책이 웹 검색을 쓴 횟수. 재검색은 크레딧을 쓰는 유일한 사용자 조작이라
--   책마다 상한을 둔다(첫 조사 1 + 재검색 5).
ALTER TABLE books ADD COLUMN web_cache TEXT;
ALTER TABLE books ADD COLUMN web_searches INTEGER NOT NULL DEFAULT 0;
