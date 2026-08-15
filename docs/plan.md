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
| 1 | **점수 공식** | `score = correctCount × 10` (최대 100) | §17 의 예시가 `10/20 → 100점`, `8/20 → 80점`. 20문항 대비 백분율(50점/40점)이 아니다. 10개 정답 시 즉시 종료(§15)와도 맞는다 |
| 2 | **아이 로그인** | 아이도 `users` 행을 갖는 독립 계정. `children` 은 프로필이며 `child_user_id` 로 계정과 연결 | §3 에서 Child 가 로그인한다. 부모가 아이 추가 시 아이 로그인 ID/비밀번호를 함께 만든다 |
| 3 | **재도전 시 새 문제** | 같은 책에 대해 `round + 1` 의 새 Quiz 를 생성하고 새 Assignment/Attempt 를 만든다 | §18 "20개의 문제는 새로운 문제로 대체한다". 기존 Quiz·Attempt 는 건드리지 않는다 |
| 4 | **재도전 비용** | 재도전마다 AI 생성이 다시 돈다 | Book Brief 를 재사용해 1·2단계를 건너뛰므로 호출은 회당 2~3회 |
| 5 | **10개 정답 조기 종료** | 10번째 정답 시점에 Attempt 를 즉시 COMPLETED 로 확정하고 격려 화면 | §15. 남은 문항은 미응답으로 남는다 |
| 6 | **문항별 즉시 채점** | 답 선택 → 정오 + 해설 표시 → 다음 문제 | §15 "문제를 풀면 다음 문제로 넘어가기 전에 결과를 보여준다" |
| 7 | **이전 문제 보기** | 되돌아가서 볼 수는 있으나 다시 답할 수 없다 (읽기 전용) | §15 두 문장을 동시에 만족시키는 유일한 해석. DB 유니크 인덱스로도 강제 |
| 8 | **웹 검색 수단** | 공개 서지 API(Open Library/Google Books) + OpenAI 내장 `web_search` 툴 | §2 "서버 측 Web Search API". 부모 키 하나만 받으면 되고 별도 검색 키가 필요 없다 |
| 9 | **모델 ID** | 코드에 고정하지 않고 설정 화면에서 선택 | 모델 라인업이 자주 바뀐다. `/v1/models` 조회로 선택지 구성 |
| 10 | **문제 삭제** | 행 삭제가 아니라 `is_active = 0` | §21.7·§21.8 과거 기록 보존 |

## 2. Phase 계획

각 Phase 는 **동작하는 상태로 끝난다.** 다음 Phase 없이도 그 지점까지 배포·확인할 수 있다.

---

### Phase 0 — 환경 구성 ✅ 완료

| 산출물 | 내용 |
| --- | --- |
| `package.json` | 레퍼런스와 동일한 devDependencies 핀 + `db:migrate:*` 스크립트 추가 |
| `tsconfig.json` | 레퍼런스와 동일 (strict) |
| `wrangler.jsonc` | ASSETS + D1(`DB`) + R2(`IMAGES`) + KV(`SESSIONS`), observability, source maps |
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
- 키 저장 **전에** `GET /v1/models` 로 검증한다. 잘못된 키가 저장되면 문제 생성 단계에서야
  실패가 드러나 진단이 어렵다.
- 복호화된 키가 나가는 통로는 `services/settings.getApiKey` 하나뿐이다. 라우트가 실수로 응답에
  담을 경로 자체를 없앴다.
- OpenAI 4xx 는 재시도하지 않는다. 429·5xx 만 1→2→4초 백오프로 최대 3회.

> `ENCRYPTION_KEY` 는 base64 로 **정확히 32바이트**여야 한다. 길이가 틀리면 키 저장이 500 으로 실패하며,
> 서버 로그에 길이 진단이 남는다. `openssl rand -base64 32` 로 생성할 것.

---

### Phase 3 — 책 등록 · 식별 · 정보 수집

| 파일 | 내용 |
| --- | --- |
| `src/utils/image.ts` | MIME 매직바이트 검사, 크기 제한, 축소 |
| `src/repositories/books.ts` | `books` · `book_sources` |
| `src/ai/vision.ts` | 표지 → 서지정보 추출 (Structured Output) |
| `src/search/bibliographic.ts` | Open Library / Google Books ISBN 조회 |
| `src/search/web.ts` | OpenAI `web_search` 기반 줄거리·서평 수집 |
| `src/services/book.ts` | 식별 → 검색 → 병합 → **Book Brief** 생성 |
| `src/routes/books.ts` | 업로드 / analyze / search / cover 프록시 |
| `public/js/pages/book-add.js` · `book-analysis.js` | 카메라·갤러리·파일 업로드 + 결과 확인/보정 |

카메라 입력은 `<input type="file" accept="image/*" capture="environment">` 로 처리한다(빌드 없는 환경에서 가장 단순하고 전 기기에서 동작).

**완료 기준** — 표지 촬영 → 제목·저자·출판사·ISBN 이 채워지고, 부모가 틀린 값을 고칠 수 있고,
`book_sources` 에 출처 URL 이 2건 이상 쌓인다.

---

### Phase 4 — AI 문제 생성 파이프라인

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

**완료 기준** — 책 하나로 `POST /generate` 호출 시 검증 통과한 20문항이 REVIEW 상태로 저장되고,
`question_histories` 에 20건의 `AI_GENERATED` 가 남는다. 정상 경로 OpenAI 호출 4회 이내.

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
- 실제 D1/R2/KV 생성 → ID 교체 → `wrangler secret put SESSION_SECRET` / `ENCRYPTION_KEY`
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
