-- 영문책의 읽기 난이도 — AR(ATOS) 과 Lexile.
--
-- 부모가 아이 수준에 맞는 책인지 판단하는 데 쓰는 값이다. 미국 학교에서 쓰는 두 척도이고
-- **영문책에만 존재한다** — 한국어 책에는 매겨지지 않으므로 화면에서도 영문책일 때만 보인다.
--
-- 값을 조사 결과에서 받되 서버가 형식을 검사하고 넣는다. 지어낸 등급은 없는 것보다 나쁘다 —
-- 부모가 그 숫자를 믿고 책을 고르기 때문이다. 형식에 안 맞으면 버리고 빈칸으로 둔다.
--
-- book_language: 이 책이 쓰인 언어(ISO 639-1). 퀴즈의 `language` 와 다르다 — 그쪽은
--   "문제를 어느 말로 낼까" 이고 이쪽은 "책이 어느 말로 쓰였나" 이다. 영문책 판정에 쓴다.
-- ar_level:  ATOS 북 레벨. 학년.개월 꼴의 소수다(4.7 = 4학년 7개월).
-- ar_points: 책 한 권을 다 읽었을 때 받는 점수. 분량에 비례한다.
-- ar_interest: 흥미 수준. LG(K-3) · MG(4-8) · MG+(6-8) · UG(9-12).
-- lexile: 렉사일 지수. 접두어가 붙을 수 있어(AD·NC·HL·IG·GN·BR) 숫자가 아니라 문자열이다.
ALTER TABLE books ADD COLUMN book_language TEXT;
ALTER TABLE books ADD COLUMN ar_level REAL;
ALTER TABLE books ADD COLUMN ar_points REAL;
ALTER TABLE books ADD COLUMN ar_interest TEXT;
ALTER TABLE books ADD COLUMN lexile TEXT;
