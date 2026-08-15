# API

모든 응답은 아래 형태를 유지한다(§31.14).

```jsonc
// 성공
{ "ok": true, "data": { /* ... */ } }
// 실패
{ "ok": false, "error": { "code": "forbidden", "message": "권한이 없습니다." } }
```

인증은 `__Host-session` HttpOnly 쿠키로 한다. 요청 body 의 `parentId`/`childId` 는 무시한다.

| 코드 | HTTP | 의미 |
| --- | --- | --- |
| `unauthorized` | 401 | 세션 없음/만료 |
| `forbidden` | 403 | 소유권 없음 |
| `not_found` | 404 | 대상 없음 |
| `conflict` | 409 | 상태 전이 불가 (예: COMPLETED 퀴즈 수정) |
| `rate_limited` | 429 | Rate Limit 초과 |
| `invalid` | 400 | 입력 검증 실패 |
| `ai_failed` | 502 | AI 호출 실패 |
| `search_unavailable` | 400 | 이 키로는 웹 검색을 쓸 수 없음 (Gemini 무료 등급) |
| `region_blocked` | 400 | 서버 위치가 차단됨 (Cloudflare Worker → Gemini) |
| `internal` | 500 | 그 외 |

## 인증 · 설정

✅ 는 구현 완료.

| Method | Path | Role | 설명 |
| --- | --- | --- | --- |
| POST | `/api/auth/signup` | – | ✅ 부모 계정 생성 (초대코드 선택) |
| POST | `/api/auth/login` | – | ✅ 로그인 → 세션 쿠키 |
| POST | `/api/auth/logout` | any | ✅ 세션 폐기 |
| GET | `/api/auth/me` | any | ✅ 현재 신원 + role (+ CHILD 면 childId) |
| GET | `/api/settings` | PARENT | ✅ `{ provider, providers, ai: { configured, last4, model, visionModel } }` — **키 원문 미포함** |
| PUT | `/api/settings/ai-key` | PARENT | ✅ `{ provider, apiKey }` 저장(암호화). 저장 전 제공자로 유효성 검증 |
| DELETE | `/api/settings/ai-key` | PARENT | ✅ 키 삭제 |
| GET | `/api/settings/ai/models` | PARENT | ✅ 저장된 키로 사용 가능한 모델 목록 조회 |
| PUT | `/api/settings/ai/models` | PARENT | ✅ 사용할 모델 저장 (계정에 실제 존재하는지 확인) |
| PUT | `/api/settings/quiz` | PARENT | ✅ `{ questionCount, passCount }` — 한 번에 낼 문제 수와 통과 기준 |

`provider` 는 `openai` | `gemini` | `vertex`.

`apiKey` 필드는 제공자에 따라 내용이 다르다 — OpenAI·Gemini 는 API Key 한 줄, Vertex 는
서비스 계정 JSON 전체다. 응답의 `keyHint` 도 제공자가 정한다(끝 4자리 / 프로젝트 이름).

`PUT /api/settings/ai-key` 는 저장 **전에** 두 가지를 확인한다.
1. 모델 목록 조회 — 키가 인증되는지
2. 아주 작은 추론 호출 — 실제로 호출이 되는지 (크레딧 부족·권한 문제를 여기서 잡는다)

1이 실패하면 아무것도 저장하지 않는다. 2가 실패하면 저장은 하되 `warning` 을 함께 돌려준다.
결제 수단을 등록하러 가는 중일 수 있어 저장 자체는 막지 않는다.

## 아이 관리

| Method | Path | Role | 설명 |
| --- | --- | --- | --- |
| GET | `/api/children` | PARENT | ✅ 내 아이 목록 |
| POST | `/api/children` | PARENT | ✅ 아이 추가 (이름·학년 + 로그인 ID/비밀번호) |
| PATCH | `/api/children/:id` | PARENT | ✅ 아이 정보·비밀번호 수정 |
| DELETE | `/api/children/:id` | PARENT | ✅ 아이 비활성화 (행 삭제 아님) |

소유하지 않은 `childId` 로 호출하면 `403` 이 아니라 **`404`** 를 준다.
403 은 "그 리소스가 존재한다"는 사실을 알려주기 때문이다.

## 책

| Method | Path | Role | 설명 |
| --- | --- | --- | --- |
| POST | `/api/books` | PARENT | ✅ 표지 이미지 업로드(multipart) → KV 저장 → book 행 생성 |
| GET | `/api/books` | PARENT | ✅ 내가 등록한 책 목록 |
| GET | `/api/books/:id` | PARENT | ✅ 책 + 출처 + 문제 생성 준비 여부 |
| GET | `/api/books/:id/cover` | PARENT | ✅ KV 이미지 프록시 서빙 (소유권 확인) |
| POST | `/api/books/:id/analyze` | PARENT | ✅ Vision 으로 제목/저자/출판사/ISBN 추출 |
| POST | `/api/books/:id/search` | PARENT | ✅ 웹 검색으로 책 정보 보강 + `book_sources` 적재 |
| PATCH | `/api/books/:id` | PARENT | ✅ 부모가 책 정보 직접 수정 (AI 오인식 보정) |
| GET | `/api/books/:id/history` | PARENT | 이 책의 퀴즈·풀이 이력 |

## 이력

| Method | Path | Role | 설명 |
| --- | --- | --- | --- |
| GET | `/api/history/questions` | PARENT | ✅ 문제 생성·수정 이력 (`bookId` · `quizId` · `limit` · `offset`) |
| GET | `/api/history/answers` | PARENT | ✅ 아이 답안 이력 (`childId` 추가 필터) |
| GET | `/api/history/filters` | PARENT | ✅ 이력 화면의 책·아이 선택지 |

답안 이력은 `question_versions` 를 조인해 **아이가 그때 본 문항 본문**을 돌려준다.
`questions` 를 그대로 읽으면 부모가 나중에 고친 문장이 과거 기록에 섞인다(§22).

## 퀴즈 생성 · 검수

| Method | Path | Role | 설명 |
| --- | --- | --- | --- |
| POST | `/api/quizzes` | PARENT | ✅ 책 기준 퀴즈 생성 (status=DRAFT, round 자동 증가) |
| POST | `/api/quizzes/:id/generate` | PARENT | ✅ 20문제 생성 시작. **202** 반환 후 백그라운드 실행 |
| GET | `/api/quizzes/:id` | PARENT | ✅ 퀴즈 + 문제 + 진행 상태 |
| GET | `/api/books/:id/quizzes` | PARENT | ✅ 이 책의 퀴즈 회차 목록 |
| PATCH | `/api/questions/:id` | PARENT | 문제 수정 → version+1, history=PARENT_EDITED |
| POST | `/api/questions/:id/regenerate` | PARENT | 이 문제만 AI 재생성 → history=AI_REGENERATED |
| DELETE | `/api/questions/:id` | PARENT | `is_active=0` + 즉시 대체 문제 1개 생성 (20개 유지) |
| GET | `/api/questions/:id/history` | PARENT | 문제 변경 이력 |
| POST | `/api/quizzes/:id/approve` | PARENT | 20개 검증 후 status=APPROVED |
| POST | `/api/quizzes/:id/assign` | PARENT | `{ childId }` → assignment 생성, status=ASSIGNED |

## 아이 풀이

| Method | Path | Role | 설명 |
| --- | --- | --- | --- |
| GET | `/api/children/:id/quizzes` | PARENT·CHILD | 제출된 퀴즈 목록 (CHILD 는 자기 것만) |
| POST | `/api/attempts` | CHILD | `{ assignmentId }` → Attempt 시작 + 20문항 스냅샷 고정. 쿨다운 검사 |
| GET | `/api/attempts/:id` | CHILD·PARENT | 진행 상태 + 현재 문항 (정답 필드는 CHILD 응답에서 제외) |
| POST | `/api/attempts/:id/answers` | CHILD | `{ questionId, selectedChoice }` → 채점 결과 즉시 반환 |
| POST | `/api/attempts/:id/submit` | CHILD | 최종 제출 → 점수·통과 여부 확정 |
| GET | `/api/children/:id/history` | PARENT·CHILD | 과거 Attempt 목록 |
| GET | `/api/children/:id/summary` | PARENT | 대시보드 집계 (총 퀴즈·통과·재도전) |

### 아이에게 정답을 보내지 않는다

`GET /api/attempts/:id` 의 CHILD 응답에서 `correctChoice` · `explanation` · `evidence` 는 제거한다.
정답은 `POST /api/attempts/:id/answers` 의 응답으로만 그 문항에 한해 노출된다.

## Rate Limit

KV 카운터(`rl:<scope>:<key>`)로 고정 윈도우 방식.

| 스코프 | 한도 |
| --- | --- |
| 로그인 | 10회 / 15분 (IP + login_id) |
| 이미지 업로드 | 20회 / 시간 (user) |
| AI 생성·검증·재생성 | 20회 / 시간 (user) |
| API Key 저장 | 10회 / 시간 (user) |
| 모델 목록 조회 | 30회 / 시간 (user) |
| 회원가입 | 5회 / 시간 (IP) |
| 그 외 API | 300회 / 분 (user) |

초과 시 `429` + `Retry-After` 헤더.

## 업로드 제한

- 최대 4MB (클라이언트가 긴 변 1024px·JPEG 0.72 로 줄여 올리므로 보통 100~300KB)
- 허용 MIME: `image/jpeg`, `image/png`, `image/webp`, `image/heic`
- `Content-Type` 헤더뿐 아니라 **매직 바이트로 실제 포맷을 재확인**한다
- KV 키: `books/<userId>/<uuid>` — 공개 접근 불가, `/api/books/:id/cover` 를 통해서만 접근
