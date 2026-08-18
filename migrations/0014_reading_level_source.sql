-- 읽기 난이도가 **어디서 왔는지**.
--
--   'web' — 전용 검색으로 실제 페이지에서 읽어낸 값
--   'ai'  — 웹에서 못 찾아 모델이 짐작한 값
--
-- 부모는 이 숫자로 아이에게 맞는 책인지 고른다. 짐작한 값을 확인된 값처럼 보여주면
-- 없는 것보다 나쁘다. 그래서 화면이 둘을 다르게 보이려면 출처를 알아야 한다.
--
-- 섞지 않는다. 웹에서 하나라도 찾았으면 그것만 쓰고, 하나도 못 찾았을 때만 통째로 짐작한다.
-- 한 줄에 확인된 값과 짐작한 값이 섞여 있으면 부모가 어느 쪽이 어느 쪽인지 알 수 없다.
ALTER TABLE books ADD COLUMN reading_level_source TEXT
	CHECK (reading_level_source IS NULL OR reading_level_source IN ('web','ai'));
