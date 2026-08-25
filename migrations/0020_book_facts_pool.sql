-- 0020_book_facts_pool.sql — 쌓아 온 등장인물·주요 사건
--
-- 0019 가 줄거리를 쌓게 했는데, 같은 조사가 함께 돌려주는 **등장인물과 주요 사건은 여전히
-- 갈아 끼우고 있었다.** 다시 찾을 때마다 지난 인물과 사건이 사라져, 줄거리만 두꺼워지고
-- 그 줄거리에 나오는 인물이 목록에서 빠지는 일이 생겼다.
--
-- `brief` 로 대신할 수 없는 이유는 0019 와 같다. 게다가 이 둘은 `[등장인물]` · `[주요 사건]`
-- 절에서 사람이 읽을 꼴로 풀어 쓰여 있어, 되읽으려면 그 꼴을 되짚어 뜯어야 한다. 원래 모양
-- (JSON)으로 두는 편이 잃는 것이 없다.
--
--   ai_characters   [{"name":"잎싹","role":"양계장을 나온 암탉"}, …]
--   ai_events       ["양계장을 떠난다", "알을 품는다", …]
--
-- 이 컬럼이 비어 있는 옛 행은 `brief` 의 두 절을 되짚어 첫 밑감으로 쓴다
-- (`services/book.ts` 의 `knownCharacters` · `knownEvents`).

ALTER TABLE books ADD COLUMN ai_characters TEXT;
ALTER TABLE books ADD COLUMN ai_events TEXT;
