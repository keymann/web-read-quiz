-- 0005_cover_key.sql — 표지 저장소를 R2 에서 KV 로 바꾸면서 컬럼 이름을 맞춘다
--
-- 컬럼 이름에 r2 가 박혀 있으면 실제로는 KV 키가 들어 있는 것을 읽는 사람이 오해한다.
-- 저장소에 중립적인 이름으로 바꾼다. 값의 형식(`books/<userId>/<uuid>`)은 그대로다.

ALTER TABLE books RENAME COLUMN cover_r2_key TO cover_key;
