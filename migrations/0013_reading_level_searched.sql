-- 읽기 난이도를 **찾아본 적이 있는지**.
--
-- 없으면 등급이 없는 책에서 `정보 다시 찾기` 를 누를 때마다 같은 검색을 다시 돈다.
-- AR·Lexile 이 아예 매겨지지 않은 책이 흔해서, 그 반복이 크레딧을 그냥 태운다.
--
-- 표시는 **검색을 시작하기 전에** 세운다. 조사 준비 단계와 반영 단계가 동시에 찾아 나서는
-- 것을 막는 자물쇠 노릇을 겸한다(`claimForGeneration` 과 같은 방식).
ALTER TABLE books ADD COLUMN reading_level_searched_at TEXT;
