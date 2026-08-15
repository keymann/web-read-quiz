-- 0006_available_models.sql — 이 계정에서 쓸 수 있는 모델 목록을 저장한다
--
-- 지금까지는 필요할 때마다 제공자에게 물어봤다. Gemini 는 서버가 부를 수 없어(요청 위치
-- 차단) 그 방법을 쓸 수 없고, 그래서 두 가지가 막혀 있었다.
--   - 설정 화면의 모델 선택 목록
--   - 모델 폴백 (실패했을 때 다른 모델로 넘어가려면 후보를 알아야 한다)
--
-- 키를 등록할 때 한 번 받은 목록을 그대로 둔다. JSON 배열 문자열이다.

ALTER TABLE parent_settings ADD COLUMN available_models TEXT;
