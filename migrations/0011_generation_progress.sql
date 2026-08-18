-- 문제 만들기의 진행 상태와 취소.
--
-- generation_phase: 지금 무엇을 하고 있는지. 브라우저 릴레이 경로는 이 값을 클라이언트가
--   직접 알지만, 서버가 도는 경로는 알 방법이 없어 "만드는 중" 한 줄만 떠 있었다.
--   30초를 넘기는 일이 흔해서 그 화면은 멈춘 것처럼 보인다.
--
-- generation_started_at: 이번 생성이 시작된 시각. 경과 시간을 화면 진입 시각이 아니라
--   실제 시작 시각부터 세야 한다 — 다른 화면에서 시작하고 넘어오면 0초부터 다시 센다.
--
-- cancel_requested: 부모가 취소를 눌렀다는 표시. 백그라운드 작업은 밖에서 죽일 수 없으므로
--   루프가 단계마다 이 값을 보고 스스로 멈춘다.
ALTER TABLE quizzes ADD COLUMN generation_phase TEXT;
ALTER TABLE quizzes ADD COLUMN generation_started_at TEXT;
ALTER TABLE quizzes ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
