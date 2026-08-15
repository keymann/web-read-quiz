# 개발 계획

## 0. 전제

- 레퍼런스 `low-grade-operator-exercise-web` 와 **동일한 개발/배포 환경**을 쓴다.
  단일 Cloudflare Worker, 빌드 단계 없음, `wrangler dev` 하나로 로컬 개발, `wrangler deploy` 하나로 배포.
- 요구사항 §30 의 `apps/web` + `workers/api` 모노레포 대신, 같은 문단이 허용한
  **Pages + Worker 통합 구조**를 택했다. 오리진이 하나라 CORS·크로스도메인 쿠키 문제가 사라진다.
- 테마색은 green 계열. 토큰은 `public/styles.css` 의 `:root` 에만 정의하고 화면 코드는 토큰만 참조한다.

## 1. 요구사항 해석 — 확정한 판단

구현 전에 명시해 둔다. 다르게 원하면 해당 Phase 전에 바꾸는 게 싸다.

| # | 항목 | 판단 | 근거 |
| --- | --- | --- | --- |
| 1 | **점수 공식** | `score = round(correctCount / passCount × 100)`, 최대 100 | §17 의 예시가 `10/20 → 100점`, `8/20 → 80점`. 20문항 대비 백분율(50점/40점)이 아니라 **통과 기준 대비 진척도**다. 기본값 20문항/10통과에서 정확히 §17 의 숫자가 나오고, 부모가 문항 수를 바꿔도 그대로 성립한다 |
| 2 | **아이 로그인** | 아이도 `users` 행을 갖는 독립 계정. `children` 은 프로필이며 `child_user_id` 로 계정과 연결 | §3 에서 Child 가 로그인한다. 부모가 아이 추가 시 아이 로그인 ID/비밀번호를 함께 만든다 |
| 3 | **재도전 시 새 문제** | 같은 책에 대해 `round + 1` 의 새 Quiz 를 생성하고 새 Assignment/Attempt 를 만든다 | §18 "20개의 문제는 새로운 문제로 대체한다". 기존 Quiz·Attempt 는 건드리지 않는다 |
| 4 | **재도전 비용** | 재도전마다 AI 생성이 다시 돈다 | Book Brief 를 재사용해 1·2단계를 건너뛰므로 호출은 회당 2~3회 |
| 5 | **10개 정답 조기 종료** | 10번째 정답 시점에 Attempt 를 즉시 COMPLETED 로 확정하고 격려 화면 | §15. 남은 문항은 미응답으로 남는다 |
| 6 | **문항별 즉시 채점** | 답 선택 → 정오 + 해설 표시 → 다음 문제 | §15 "문제를 풀면 다음 문제로 넘어가기 전에 결과를 보여준다" |
| 7 | **이전 문제 보기** | 되돌아가서 볼 수는 있으나 다시 답할 수 없다 (읽기 전용) | §15 두 문장을 동시에 만족시키는 유일한 해석. DB 유니크 인덱스로도 강제 |
| 8 | **웹 검색 수단** | 제공자 내장 검색 툴 (OpenAI `web_search` / Gemini Google 검색 그라운딩). 막히면 모델 지식 폴백 | §2 "서버 측 Web Search API". 부모 키 하나만 받으면 되고 별도 검색 키가 필요 없다. **단 Gemini 무료 등급에서는 그라운딩이 막힌다 — Phase 3.5 참고** |
| 9 | **모델 ID** | 코드에 고정하지 않고 설정 화면에서 선택. 실패하면 다른 모델로 자동 폴백 | 모델 라인업이 자주 바뀌고 인기 모델은 과부하가 잦다 |
| 10 | **문제 삭제** | 행 삭제가 아니라 `is_active = 0` | §21.7·§21.8 과거 기록 보존 |

## 2. Phase 계획

각 Phase 는 **동작하는 상태로 끝난다.** 다음 Phase 없이도 그 지점까지 배포·확인할 수 있다.

---

### Phase 0 — 환경 구성 ✅ 완료

| 산출물 | 내용 |
| --- | --- |
| `package.json` | 레퍼런스와 동일한 devDependencies 핀 + `db:migrate:*` 스크립트 추가 |
| `tsconfig.json` | 레퍼런스와 동일 (strict) |
| `wrangler.jsonc` | ASSETS + D1(`DB`) + KV(`SESSIONS`·`IMAGES`), observability, source maps |
| `migrations/0001_initial.sql` | 전체 스키마 15테이블 |
| `src/index.ts` · `src/types.ts` · `src/utils/response.ts` | 라우터 골격 + 공통 응답 포맷 |
| `public/` | SPA 셸 + green 디자인 토큰 |
| `.dev.vars.example` | `SESSION_SECRET` / `ENCRYPTION_KEY` / `INVITE_CODE` |
| `docs/` | architecture · database · api · ai-question-generation · plan |

검증 완료: `npm run check` 통과 / `wrangler dev` 에서 `/api/health` 200 / D1 로컬 마이그레이션 적용 성공.

> **배포 전 필요한 실제 리소스 생성** — 아래 3개를 만들고 `wrangler.jsonc` 의 placeholder ID 를 교체해야 한다.
> 로컬 개발은 placeholder 로도 동작한다.
> ```bash
> npx wrangler d1 create web-read-quiz
> npx wrangler r2 bucket create web-read-quiz-images
> npx wrangler kv namespace create SESSIONS
> ```

---

### Phase 1 — 인증 · 계정 · 권한 ✅ 완료

| 파일 | 내용 |
| --- | --- |
| `src/auth/password.ts` | PBKDF2-SHA256 (WebCrypto, 100k iterations, per-user salt) |
| `src/auth/session.ts` | HS256 토큰 발급/검증, KV 세션 레코드, HttpOnly 쿠키 |
| `src/auth/guards.ts` | `requireParent` / `requireChild` / `requireOwnedChild` / `requireChildAccess` |
| `src/utils/ratelimit.ts` · `csrf.ts` · `validate.ts` · `base64.ts` · `id.ts` | 공통 유틸 |
| `src/repositories/users.ts` · `children.ts` | D1 접근 |
| `src/routes/router.ts` · `auth.ts` · `children.ts` | 경로 매칭 + 라우트 |
| `public/js/` | `api.js` `ui.js` `router.js` `session.js` + `pages/` 4개 화면 |
| `public/_headers` | 정적 자산 CSP·보안 헤더 |
| `test/` | vitest 통합 테스트 21개 |

**완료 기준 달성** — 부모 가입 → 로그인 → 아이 추가 → 아이 계정으로 로그인 → 각 role 의 홈 진입까지
브라우저에서 확인. 다른 부모의 `childId` 호출은 404, 아이 계정의 부모 API 호출은 403.

Phase 1 에서 확정한 사항:

- 쿠키는 HTTPS 에서 `__Host-session`, 로컬 http 에서 `session`. `__Host-` 프리픽스가 `Secure` 를 요구해서다.
- `SameSite` 는 `Strict` 가 아니라 `Lax`. Strict 면 외부 링크 진입 시 로그아웃처럼 보인다.
  크로스 사이트 POST 는 Lax + Origin 검사로 막는다.
- 소유하지 않은 리소스는 403 이 아니라 **404**. 403 은 존재 사실을 알려준다.
- 정적 자산은 Worker 를 거치지 않으므로 CSP 는 `public/_headers` 에 둔다.

---

### Phase 2 — 부모 설정 (OPENAI_API_KEY) ✅ 완료

| 파일 | 내용 |
| --- | --- |
| `src/utils/crypto.ts` | AES-GCM 암복호화 (`ENCRYPTION_KEY` 기반, 매번 새 IV) |
| `src/repositories/settings.ts` | `parent_settings` 접근 (upsert) |
| `src/ai/client.ts` | OpenAI 호출 래퍼 (타임아웃·백오프 재시도·에러 변환) |
| `src/ai/models.ts` | 접두사 선호 목록 + `/v1/models` 조회·필터 |
| `src/services/settings.ts` | 키 검증·보관, 모델 선택. **복호화 통로는 `getApiKey` 하나** |
| `src/routes/settings.ts` | 키 저장/삭제/조회, 모델 목록/저장 |
| `public/js/pages/settings.js` | 설정 화면 + 키 발급 가이드(§25) |
| `test/settings.test.ts` | 통합 테스트 15개 (fetchMock 으로 OpenAI 대체) |

**완료 기준 달성** — 키 저장 시 OpenAI 로 검증 후 저장, `GET /api/settings` 는
`{configured, last4, model, visionModel}` 만 반환, D1 에는 암호문만 존재.

Phase 2 에서 확정한 사항:

- **모델 ID 를 코드에 고정하지 않는다.** 접두사 선호 목록으로 계정의 실제 모델 목록에서 고른다.
  라인업이 바뀌어도 배열에 문자열 하나만 추가하면 되고, 그 모델이 없는 계정은 다음 순위를 쓴다.
  실제 계정으로 확인한 결과 59개 목록이 25개로 줄고, 구조화 출력을 못 쓰는 `*-instruct` 와
  대상이 조용히 바뀌는 `*-chat-latest`, 날짜 스냅샷이 후보에서 빠진다.
- 키 저장 **전에** `GET /v1/models` 로 검증한다. 잘못된 키가 저장되면 문제 생성 단계에서야
  실패가 드러나 진단이 어렵다.
- 복호화된 키가 나가는 통로는 `services/settings.getApiKey` 하나뿐이다. 라우트가 실수로 응답에
  담을 경로 자체를 없앴다.
- OpenAI 4xx 는 재시도하지 않는다. 429·5xx 만 1→2→4초 백오프로 최대 3회.

> `ENCRYPTION_KEY` 는 base64 로 **정확히 32바이트**여야 한다. 길이가 틀리면 키 저장이 500 으로 실패하며,
> 서버 로그에 길이 진단이 남는다. `openssl rand -base64 32` 로 생성할 것.

---

### Phase 3 — 책 등록 · 식별 · 정보 수집 ✅ 완료

| 파일 | 내용 |
| --- | --- |
| `migrations/0002_book_analysis.sql` | `cover_mime` · `brief` · `analyzed_at` · `searched_at` 추가 |
| `src/utils/image.ts` | 매직 바이트 포맷 판정, 4MB 상한, data URL 변환 |
| `src/repositories/books.ts` | `books` · `book_sources` |
| `src/ai/responses.ts` | Responses API + Structured Output 공통 호출부 |
| `src/ai/schemas.ts` | 식별·조사 JSON Schema |
| `src/ai/vision.ts` | 표지 → 서지정보 추출 |
| `src/search/bibliographic.ts` | Google Books / Open Library ISBN 조회 (키 불필요) |
| `src/search/web.ts` | OpenAI `web_search` 기반 줄거리·서평 수집 |
| `src/services/book.ts` | 식별 → 검색 → 병합 → **Book Brief** 생성 |
| `src/routes/books.ts` | 업로드 / 목록 / 상세 / analyze / search / cover 프록시 |
| `public/js/image.js` | 브라우저 canvas 축소 (긴 변 1024px, JPEG 0.72) |
| `public/js/pages/book-add.js` · `book-detail.js` · `book-list.js` | 화면 |
| `test/books.test.ts` | 통합 테스트 16개 |

카메라 입력은 `<input type="file" accept="image/*" capture="environment">` 로 처리한다
(빌드 없는 환경에서 가장 단순하고 전 기기에서 동작).

**완료 기준 달성** — 표지 업로드 → KV 저장 → AI 식별 → 부모 보정 → 웹 검색 → `book_sources` 적재 →
Book Brief 생성까지 동작. 자료가 2건 미만이면 `readyForQuiz = false` 로 문제 생성을 막는다.

Phase 3 에서 확정한 사항:

- **이미지 축소는 브라우저에서 한다.** Workers 런타임에 이미지 디코더가 없다. 클라이언트가
  긴 변 1024px 로 줄여 올리고, 서버는 매직 바이트로 포맷을 다시 판정한다 — 축소는 최적화일 뿐
  신뢰 경계가 아니다.
- **책을 특정하지 못한(`found: false`) 검색 결과의 서지정보는 받아들이지 않는다.** 엉뚱한 책의
  정보가 섞이면 부모가 알아채기 어렵고 그대로 문제 생성 입력이 된다.
- **부모가 고친 값을 검색 결과가 덮어쓰지 않는다.** 우선순위는 기존 값 > 공개 서지 API > 웹 검색.
- 검색을 다시 돌리면 이전 출처를 지우고 새로 쌓는다. 오래된 근거가 섞이지 않게.

---

### Phase 3.5 — AI 제공자 추가 (Gemini) ✅ 완료

OpenAI 는 어떤 추론 호출에도 결제 수단이 필요하다. 부모가 부담 없이 시작할 수 있는 경로가 하나는
있어야 해서 Gemini 를 붙였다. 상위 레이어는 `AiProvider` 인터페이스만 본다.

| 파일 | 내용 |
| --- | --- |
| `migrations/0003_ai_provider.sql` | `ai_provider` 추가 + 키·모델 컬럼을 제공자 중립 이름으로 |
| `src/ai/types.ts` | `AiProvider` 인터페이스 |
| `src/ai/http.ts` | 타임아웃·백오프 재시도 공통부 |
| `src/ai/openai.ts` · `gemini.ts` | 제공자 구현 |
| `src/ai/keyshape.ts` | 키 형식 사전 검사 |
| `src/ai/fallback.ts` | 모델 폴백 |
| `test/gemini.test.ts` | 통합 테스트 14개 |

**실측으로 확인한 것** — 문서만 보고는 알 수 없던 것들이다.

| 항목 | 결과 |
| --- | --- |
| Gemini 무료 등급 이미지 입력 | ✅ 동작 (표지 4개 항목 정확 추출, confidence 1.0) |
| **Cloudflare Worker 에서 Gemini 호출** | ❌ **불가**. `400 FAILED_PRECONDITION: User location is not supported`. Google 이 요청을 보낸 서버의 위치를 보고 막는다. 로컬(개인 PC)에서는 같은 키로 잘 된다 |
| Cloudflare Worker 에서 OpenAI 호출 | ✅ 동작. 지역 제한 없음 |
| Gemini 무료 등급 구조화 출력 | ✅ 동작 |
| **Gemini 무료 등급 Google 검색 그라운딩** | ❌ **불가**. 같은 키·같은 모델로 일반 호출은 200 인데 `google_search` 를 붙이면 429 |
| Google Books API (키 없이) | ❌ 익명 공유 쿼터가 이미 소진되어 있음 |
| Open Library | ❌ 한국 아동도서 데이터 없음 |

> **배포 환경에서는 Gemini 를 쓸 수 없다.** 위 표의 두 번째 줄이 결정적이다. Gemini 는 로컬 개발에서만
> 쓸 수 있고, 배포된 서버는 OpenAI 를 써야 한다. 설정 화면과 에러 메시지(`region_blocked`)로 안내한다.
> Vertex AI(`aiplatform.googleapis.com`)는 호출자 위치 제한이 없지만 API Key 가 아니라 GCP 서비스
> 계정 OAuth 를 요구해 별도 작업이 필요하다.

그래서 검색이 막히면 **모델이 아는 지식으로 정리하는 폴백**을 넣었다. `groundingUsed: false` 와
안내 문구를 함께 내려 부모가 근거의 약함을 알 수 있게 한다. 실제 책으로 확인한 결과 널리 알려진
아동도서는 이 경로만으로도 줄거리·인물·사건이 정확하게 나온다.

Phase 3.5 에서 확정한 사항:

- **키 형식을 화이트리스트로 막지 않는다.** Google 키는 `AIza…` 39자만 있는 줄 알았는데 `AQ.…` 53자도
  발급된다. 형식 검사는 "다른 제공자의 키를 붙여넣은" 명백한 실수만 잡고, 유효성은 제공자 API 가 판정한다.
- **`found` 를 모델에게 묻지 않는다.** 스키마 첫 필드로 두면 내용을 떠올리기 전에 판단을 확정해 버려
  아는 책인데도 false 로 빠진다. 서버가 채워진 내용을 보고 도출한다.
- **프롬프트에 제목·저자를 항상 넣는다.** ISBN 만 보내면 검색 없이는 책을 알아볼 방법이 없다.
- **모델 폴백** — 503·404·429 는 다른 모델로 넘어가면 대부분 그냥 성공한다. 폴백이 일어나면 부모에게 알린다.
  키 오류·크레딧 부족·그라운딩 권한 문제는 모델을 바꿔도 같으므로 폴백하지 않는다.

---

### Phase 4 — AI 문제 생성 파이프라인 ✅ 완료

| 파일 | 내용 |
| --- | --- |
| `src/ai/generate.ts` | 20문제 생성 (Structured Output) |
| `src/ai/validate.ts` | 20문제 일괄 검증 |
| `src/ai/schemas.ts` | JSON Schema 정의 모음 |
| `src/services/generation.ts` | 6단계 파이프라인 오케스트레이션 + 서버 사후 검사 |
| `src/repositories/quizzes.ts` · `questions.ts` | 문제 + version + history 동시 기록 |
| `src/routes/quizzes.ts` | `generate`(202) / `validate` / 상태 조회 |
| `public/js/pages/quiz-generation.js` | 진행률 폴링 화면 |

상세 설계는 `docs/ai-question-generation.md`.

**완료 기준 달성** — 실제 Gemini 무료 키로 `마당을 나온 암탉` 20문항 생성 확인(약 90초).
`question_histories` 에 20건의 `AI_GENERATED`, `question_versions` 에 v1 20건, `question_validations`
20건이 함께 남는다. Book Brief 가 이미 있으므로 **정상 경로 AI 호출은 2회**(생성 1 + 검증 1)다.

Phase 4 에서 확정한 사항:

- **정답 위치는 서버가 보장한다.** §9-10 "정답을 1번에 편중시키지 마라"를 모델에게 부탁하는 대신
  선택지를 재배열해 1·2·3·4번에 정확히 5문항씩 오게 만든다. 선택지 내용은 그대로라 의미는 변하지 않는다.
  실측에서 모델이 전부 1번을 정답으로 내놓아도 5/5/5/5 가 나온다.
- **AI 검증 전에 서버가 먼저 거른다.** 선택지 중복·근거 누락·제목/저자 직접 언급(§7 금지 유형)·
  기존 문항과의 중복(자카드 0.7)은 코드로 잡는다. 여기서 줄어든 만큼 검증 호출이 싸진다.
- **탈락분만 재생성한다.** 20문항을 통째로 다시 만들지 않는다. 재생성 프롬프트에 살아남은 문항과
  탈락 사유를 함께 넣어 같은 실수를 반복하지 않게 한다. 최대 3라운드.
- **생성은 `ctx.waitUntil` 로 백그라운드에서 돈다.** 202 를 즉시 돌려주고 클라이언트가 폴링한다.
  동시에 두 번 눌러도 하나만 통과하도록 상태 확인과 전이를 한 UPDATE 문으로 처리한다.
- 백그라운드에서 터진 예외는 아무도 못 보므로 반드시 `generation_error` 에 남긴다.

---

### Phase 4.5 — 출제 설정 · 문제/답 이력 ✅ 완료

요구사항은 20문제 중 10문제 통과를 고정값으로 쓰지만(§17·§21.1), 아이의 학년과 책 분량에 따라
부모가 조절할 수 있어야 한다는 요청에 따라 설정으로 뺐다. 기본값은 요구사항 그대로 20/10.

| 파일 | 내용 |
| --- | --- |
| `migrations/0004_quiz_settings.sql` | `parent_settings` 와 `quizzes` 에 `question_count` · `pass_count` |
| `src/repositories/history.ts` · `src/routes/history.ts` | 문제·답 이력 조회 |
| `public/js/pages/settings-quiz.js` · `settings-history.js` | 설정 탭 |
| `test/quiz-settings.test.ts` | 통합 테스트 14개 |

확정한 사항:

- **설정값을 퀴즈에 복사해 둔다.** 설정을 나중에 바꿔도 이미 만든 퀴즈의 통과 기준이 따라 바뀌면
  아이가 이미 푼 결과의 합격 여부가 뒤집힌다. `quizzes.question_count` · `pass_count` 에 스냅샷한다.
- 허용 범위는 5~30문항. 아래로는 통과 기준을 세울 수 없고, 위로는 아이의 집중력과 AI 응답 길이가
  감당하지 못한다. 통과 개수는 1 이상 문항 수 이하.
- 유형·난이도 분배 힌트는 문항 수에 비례해 계산한다(8종 최소 `count/8`문항, Easy·Hard 각 30%).
- **답안 이력은 `question_versions` 를 조인한다.** `questions` 를 그대로 읽으면 부모가 나중에 고친
  문장이 과거 기록에 섞인다(§22). 테스트로 이 점을 못박아 두었다.
- 설정 탭은 경로(`/parent/settings/:tab`)에 담는다. 새로고침·뒤로가기가 그대로 동작한다.

---

### Phase 5 — 부모 검수

| 파일 | 내용 |
| --- | --- |
| `src/services/question.ts` | 수정 시 version+1, 삭제 시 `is_active=0` + 대체 문항 생성, 20개 불변식 |
| `src/routes/questions.ts` | PATCH / regenerate / DELETE / history |
| `public/js/pages/quiz-review.js` · `quiz-edit.js` | 20문항 목록 + 인라인 편집 |

문제 삭제 시 곧바로 대체 문항 1개를 생성해 활성 20개를 유지한다(§11).
승인(`approve`)은 활성 20개 + 전원 검증 통과일 때만 허용한다.

**완료 기준** — 문제 수정 → `question_versions` 에 v2 추가, v1 보존, `PARENT_EDITED` 이력 기록.
COMPLETED 퀴즈에 PATCH 하면 409.

---

### Phase 6 — 제출 · 아이 풀이

| 파일 | 내용 |
| --- | --- |
| `src/services/assignment.ts` | 제출, 상태 전이 |
| `src/services/attempt.ts` | Attempt 시작 시 20문항 version 스냅샷, 채점, 조기 종료 |
| `src/repositories/attempts.ts` | `quiz_attempts` · `attempt_questions` · `question_answers` |
| `src/routes/attempts.ts` | attempts / answers / submit |
| `public/js/pages/quiz-assignment.js` | 부모: 아이 선택 후 제출 |
| `public/js/pages/child-home.js` · `quiz-play.js` · `quiz-result.js` | 아이 화면 |

아이 화면 규칙: 한 화면에 한 문제, `7 / 20` 진행 표시, 큰 선택지 버튼(`.kid` 토큰),
답 선택 즉시 정오 표시, 이전 문제는 읽기 전용 열람.

**완료 기준** — 아이가 로그인해 제출된 퀴즈를 풀고 결과가 저장된다.
10문항 정답 시점에 즉시 종료된다. 다른 아이의 assignment id 로 호출하면 403.

---

### Phase 7 — 결과 · 재도전

| 파일 | 내용 |
| --- | --- |
| `src/services/retry.ts` | 20분 쿨다운 검사, `round+1` Quiz 생성 트리거 |
| `public/js/pages/quiz-result.js` | PASS/FAIL 화면 + 남은 대기 시간 카운트다운 |

쿨다운은 **서버에서** 마지막 Attempt 의 `completed_at` 기준으로 계산한다. 클라이언트 타이머는 표시용.

**완료 기준** — FAIL 후 20분 이내 재도전 시 429/409, 20분 후 새 문제 20개로 Attempt #2 생성.
Attempt #1 의 문항·답안은 그대로 조회된다.

---

### Phase 8 — 대시보드 · 이력

| 파일 | 내용 |
| --- | --- |
| `src/repositories/stats.ts` | 집계 쿼리 (총 퀴즈 / 통과 / 재도전 / 책별 도전 횟수) |
| `src/routes/stats.ts` | `children/:id/summary`, `children/:id/history`, `books/:id/history` |
| `public/js/pages/parent-dashboard.js` · `quiz-history.js` · `child-history.js` | 화면 |

§19 의 화면 구성(내 아이 → 최근 독서 퀴즈 → 총계 → 책별 상세)을 그대로 만든다.

---

### Phase 9 — 보안 하드닝 · 테스트 · 배포

- `test/` 에 vitest + `@cloudflare/vitest-pool-workers` 로 통합 테스트
  - 권한 우회 시도 (다른 부모/아이 리소스 접근)
  - 스냅샷 불변성 (문제 수정 후 과거 Attempt 재조회)
  - 20문항 불변식, 조기 종료, 쿨다운
  - Rate Limit
- XSS: 모든 사용자·AI 생성 문자열은 `textContent` 로 렌더링한다. `innerHTML` 은 정적 템플릿에만.
- CSP 헤더 추가 (`default-src 'self'`)
- 실제 D1/KV 생성 → ID 교체 → `wrangler secret put SESSION_SECRET` / `ENCRYPTION_KEY`
- `npm run db:migrate:remote` → `npm run deploy`

## 3. 화면 ↔ Phase 대응

| 화면 | Role | Phase |
| --- | --- | --- |
| Login | 공통 | 1 |
| Parent Home | Parent | 1 |
| Child Management | Parent | 1 |
| Settings (API Key) | Parent | 2 |
| Book Add | Parent | 3 |
| Book Analysis | Parent | 3 |
| Quiz Generation | Parent | 4 |
| Quiz Review | Parent | 5 |
| Quiz Edit | Parent | 5 |
| Quiz Assignment | Parent | 6 |
| Child Result | Parent | 6 |
| Quiz History | Parent | 8 |
| Child Home | Child | 6 |
| Assigned Quiz | Child | 6 |
| Quiz (풀이) | Child | 6 |
| Quiz Result | Child | 7 |
| Quiz History | Child | 8 |

## 4. 리스크

| 리스크 | 영향 | 대응 |
| --- | --- | --- |
| **`waitUntil` 시간 초과** — 20문제 생성+검증이 백그라운드 실행 한계를 넘을 수 있다 | 생성 실패 | 단계별로 D1 에 중간 저장해 재개 가능하게 만든다. 반복되면 Cloudflare Queues 로 이전 (바인딩 추가만 하면 됨) |
| **AI 가 책 내용을 지어냄** — 검색으로 얻은 정보가 얕으면 없는 사건을 만든다 | 문제 품질 저하 | 5단계 검증의 10번 기준(존재하지 않는 내용)을 강조. `book_sources` 가 2건 미만이면 생성 자체를 막고 부모에게 알린다 |
| **비용** — 부모 키로 결제되므로 재도전마다 비용 발생 | 사용자 불만 | Book Brief 재사용으로 호출 최소화. 설정 화면에 회당 예상 호출 수 안내. 사용자당 시간당 20회 Rate Limit |
| **아동 개인정보** — 미성년자 데이터를 저장한다 | 규제 | 수집 항목을 이름·학년으로 최소화. 부모 계정 삭제 시 CASCADE 로 전량 삭제 |
| **모델 ID 변경** | 호출 실패 | 모델을 설정값으로 뺐다. `/v1/models` 조회로 유효한 선택지만 노출 |
| **빌드 없는 SPA 의 코드 규모** — 화면 16개 | 유지보수 | 화면당 1파일 ES module + 얇은 라우터. 공통 로직은 `api.js`/`ui.js` 로 추출. 한 파일 300줄을 넘기면 분리 |

## 5. 다음 행동

Phase 1 부터 순서대로 진행한다. Phase 3·4 는 실제 OpenAI 키가 있어야 종단 확인이 가능하므로,
Phase 2 완료 시점에 키를 준비해 두면 좋다.
