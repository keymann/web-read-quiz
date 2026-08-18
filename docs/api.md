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
| POST | `/api/auth/signup` | – | ✅ 부모 계정 생성. **초대 코드 필수** — 틀리거나 서버에 미설정이면 403 |
| POST | `/api/auth/login` | – | ✅ 로그인 → 세션 쿠키 |
| POST | `/api/auth/logout` | any | ✅ 세션 폐기 |
| GET | `/api/auth/me` | any | ✅ 현재 신원 + role (+ CHILD 면 childId) |
| GET | `/api/settings` | PARENT | ✅ `{ provider, providers, ai: { configured, last4, model, visionModel } }` — **키 원문 미포함** |
| PUT | `/api/settings/ai-key` | PARENT | ✅ `{ provider, apiKey, models? }` 저장(암호화). 저장 전 제공자로 유효성 검증 |
| DELETE | `/api/settings/ai-key` | PARENT | ✅ 키 삭제 |
| GET | `/api/settings/ai/models` | PARENT | ✅ 사용 가능한 모델 목록 (gemini 는 키 등록 때 받아 둔 목록) |
| PUT | `/api/settings/ai/models` | PARENT | ✅ 사용할 모델 저장 (계정에 실제 존재하는지 확인) |
| PUT | `/api/settings/quiz` | PARENT | ✅ `{ questionCount, passCount, questionLanguage? }` — 문제 수·통과 기준·문제 언어 |

`provider` 는 `openai` | `gemini` | `vertex`.

`apiKey` 필드는 제공자에 따라 내용이 다르다 — OpenAI·Gemini 는 API Key 한 줄, Vertex 는
서비스 계정 JSON 전체다. 응답의 `keyHint` 도 제공자가 정한다(끝 4자리 / 프로젝트 이름).

`PUT /api/settings/ai-key` 는 저장 **전에** 두 가지를 확인한다.
1. 모델 목록 조회 — 키가 인증되는지
2. 아주 작은 추론 호출 — 실제로 호출이 되는지 (크레딧 부족·권한 문제를 여기서 잡는다)

1이 실패하면 아무것도 저장하지 않는다. 2가 실패하면 저장은 하되 `warning` 을 함께 돌려준다.
결제 수단을 등록하러 가는 중일 수 있어 저장 자체는 막지 않는다.

**`provider: "gemini"` 는 예외다.** 서버가 Gemini 를 부를 수 없으므로(지역 차단) 두 확인을
모두 건너뛰고, 대신 브라우저가 조회해 온 `models` 를 **필수로** 받는다. 그 조회가 성공했다는
것 자체가 키가 유효하다는 증거다. 서버는 받은 목록을 자기 기준으로 거르고 정렬한 뒤
저장하므로, 못 쓰는 모델만 보내면 400 이다. 자세한 배경은
[architecture.md](architecture.md) 의 "브라우저 릴레이" 참고.

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

`GET /api/books/:id` 의 `book` 에는 **영문책의 읽기 난이도**가 함께 실린다.

```jsonc
{
  "language": "en",              // 책이 쓰인 말(ISO 639-1). 퀴즈의 language 와 다르다
  "readingLevel": {              // 하나도 못 알아냈으면 null
    "ar": 4.4,                   // ATOS 북 레벨 — 4학년 4개월
    "arPoints": 5,               // 다 읽으면 받는 AR 포인트
    "arInterest": "MG",          // LG · MG · MG+ · UG
    "lexile": "680L"             // 접두어 포함(AD·NC·HL·IG·GN·BR)
  }
}
```

AR·Lexile 은 **영문책에만 매겨진다.** 값은 조사 모델에게 묻지 않고 `POST /api/books/:id/search`
안에서 **등급 전용 웹 검색**을 한 번 더 던져 정규식으로 뽑는다(크레딧 1). 등급은 페이지에
`ATOS Book Level: 4.4` 처럼 이름표를 달고 적혀 있어 추론이 필요 없고, 모델을 태우지 않으니
지어낼 여지도 없다.

처음에는 조사 프롬프트에 필드만 얹었는데 획득률이 0 이었다 — 줄거리를 찾는 질의
(`plot summary characters book review`)로는 등급이 적힌 페이지가 결과에 들어오지 않는다.

- 제목이 맞지 않는 페이지는 보지 않는다(줄거리 검색보다 엄격한 0.9). 부모는 숫자를 그냥 믿는다.
- 실존 범위를 벗어난 값은 버린다(ATOS ≤ 20, 포인트 ≤ 200).
- 여러 페이지가 갈리면 다수를 따르고, 이미 확인해 둔 값은 다시 조사해도 바뀌지 않는다.
- 한국어 책이면 검색 자체를 하지 않는다.

## 브라우저 릴레이 (Gemini 전용 · PARENT)

| Method | Path | 설명 |
| --- | --- | --- |
| GET | `/api/ai/credential` | ✅ 브라우저가 쓸 Gemini 키·모델. **제공자가 gemini 일 때만** |
| POST | `/api/ai/plan` | ✅ `{kind, …}` → 브라우저가 그대로 보낼 요청 |
| POST | `/api/ai/apply` | ✅ 브라우저가 받아 온 Gemini 원본 응답을 서버가 해석·반영 |

`kind` — plan: `identify` · `research` · `generate` · `validate` / apply: `identify` · `research` · `accept`

**문제 생성·검증은 요청이 여러 개다.** `generate`·`validate` 의 plan 은 `{url, body}` 대신
`calls: [{url, body}, …]` 를 돌려주고, 브라우저가 그것을 **동시에** 보낸 뒤 받은 응답들을
`responses: […]` 로 되돌려준다. 나누는 규칙은 서버 경로와 같다(`generation.planChunks`).

한 덩어리로 뽑으면 그것만 80초가 걸린다(실측 Gemini, 20문항). 출력 토큰을 만드는 시간이
곧 임계 경로라, 나눠 나란히 부르면 가장 느린 하나만 기다린다.

청크는 서로의 결과를 못 보므로 번호가 겹친다. `validate` plan 이 합치면서 **번호를 다시
매기고**, 그 번호를 `accept` 까지 그대로 쓴다 — 번호가 검수 결과를 문항에 잇는 열쇠다.
하나가 깨져도 나머지로 간다. 책 식별·조사는 호출이 하나뿐이라 예전 모양 그대로다.

자세한 배경은 [architecture.md](architecture.md) 의 "브라우저 릴레이" 참고.

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
| POST | `/api/quizzes` | PARENT | ✅ `{ bookId, language? }` — 퀴즈 생성 (status=DRAFT, round 자동 증가) |
| POST | `/api/quizzes/:id/generate` | PARENT | ✅ **빈 자리만** 채운다. **202** 반환 후 백그라운드 실행 |
| POST | `/api/quizzes/:id/cancel` | PARENT | ✅ 만들기 중단 요청. **표시만 남기고 곧바로 응답한다** |
| POST | `/api/quizzes/:id/regenerate` | PARENT | ✅ `{ questionIds }` — 고른 문항만 비활성화. 채우기는 `generate` |
| GET | `/api/quizzes/:id` | PARENT | ✅ 퀴즈 + 문제 + 진행 상태 + 내준 아이 |
| POST | `/api/quizzes/:id/assign` | PARENT | ✅ `{ childId }` → assignment 생성, status=ASSIGNED |
| GET | `/api/books/:id/quizzes` | PARENT | ✅ 이 책의 퀴즈 회차 목록 |
| PATCH | `/api/questions/:id` | PARENT | 문제 수정 → version+1, history=PARENT_EDITED |
| GET | `/api/questions/:id/history` | PARENT | 문제 변경 이력 |
| POST | `/api/quizzes/:id/approve` | PARENT | 검증 후 status=APPROVED |

`POST /api/quizzes` 의 `language` 는 `en` | `ko`. 안 보내면 부모 설정의 기본값(초기값 `en`)이고,
값은 퀴즈 행에 **복사된다** — 나중에 설정을 바꿔도 이미 만든 퀴즈의 언어는 그대로다. 부족한
문항을 채울 때 언어가 섞이지 않게 하기 위해서다(`question_count`·`pass_count` 와 같은 이유).

**`regenerate` 는 지우기만 한다.** 채우는 경로가 서버(백그라운드)와 브라우저 릴레이로 갈라져
있어, 여기서 생성까지 시작하면 릴레이 쪽은 막힌 경로로 나간다. 화면이 응답을 받고 자기에게
맞는 경로로 잇는다. `generate` 도 남아 있는 문항은 건드리지 않고 빈 자리만 채운다 — 통째로
다시 만들면 애써 확인한 문항이 사라진다.

## 아이 풀이

Attempt 는 시작할 때 그 시점의 활성 문항을 **버전 단위로 고정한다**(§22). 이후 부모가 문제를
고치거나 지워도 진행 중인 판은 흔들리지 않고, 나중에 이력을 볼 때도 "그때 본 문항" 이 그대로
재구성된다. 본문·선택지·정답을 모두 `question_versions` 에서 읽는다.

**정답은 아직 답하지 않은 문항에서 빠진다.** 응답에 담기기만 해도 개발자 도구로 볼 수 있다.
채점은 서버가 하므로 클라이언트가 정답을 알아야 할 이유가 없고, 답한 뒤에는 그때 담아 준다.

통과 기준만큼 맞히면 **그 자리에서 판이 끝난다**(§15 조기 종료). 남은 문항은 미응답으로 남는다.
점수는 `round(정답 수 / 통과 기준 × 100)`, 최대 100 — 문항 수 대비 백분율이 아니라 **통과 기준
대비 진척도**다(§17).

`GET /api/attempts/:id` 는 `retry` 를 함께 준다.

| `retry.status` | 뜻 |
| --- | --- |
| `PASSED` | 통과했다. 재도전할 이유가 없다 |
| `COOLDOWN` | 아직 기다려야 한다 (`waitSeconds`) |
| `READY` | 지금 재도전을 시작할 수 있다 |
| `PREPARING` | 새 회차를 만들었고 서버가 문제를 만드는 중 (`prepared` / `total`) |
| `NEEDS_PARENT` | 새 회차는 만들었지만 문제는 **부모의 브라우저**가 만들어야 한다(Gemini) |
| `FAILED` | 만들려다 실패했다(`error` 에 사유). 기다려도 저절로 되지 않는다 |
| `WAITING` | 새 회차의 문제가 준비됐다 (`nextAssignmentId` 로 시작) |

`GET /api/my/quizzes` 의 `ready` 는 문항이 다 찼는지다. 재도전은 배정을 먼저 만들고 문제를
나중에 만들기 때문에, 이 값이 false 인 동안 아이는 그 퀴즈를 시작할 수 없다.

| Method | Path | Role | 설명 |
| --- | --- | --- | --- |
| GET | `/api/my/quizzes` | CHILD | ✅ 내가 받은 퀴즈 (아직 안 끝난 것만) |
| GET | `/api/my/attempts` | CHILD | ✅ 내 지난 기록 |
| POST | `/api/attempts` | CHILD | ✅ `{ assignmentId }` → Attempt 시작 + 문항 스냅샷 고정 |
| GET | `/api/attempts/:id` | CHILD | ✅ 진행 상태 + 문항 (**안 푼 문항에는 정답이 실리지 않는다**) |
| POST | `/api/attempts/:id/answers` | CHILD | ✅ `{ questionNumber, selectedChoice }` → 채점 결과 즉시 반환 |
| POST | `/api/attempts/:id/submit` | CHILD | ✅ 남은 문항을 두고 그만두기 → 점수·통과 확정 |
| POST | `/api/attempts/:id/retry` | CHILD | ✅ 재도전 — 같은 책의 `round+1` 회차 + 새 배정 생성 |
| GET | `/api/children/:id/quizzes` | PARENT·CHILD | 제출된 퀴즈 목록 (CHILD 는 자기 것만) |

## 대시보드

| Method | Path | Role | 설명 |
| --- | --- | --- | --- |
| GET | `/api/dashboard` | PARENT | ✅ 아이별 집계 + 최근 독서 퀴즈 + 합계 |
| GET | `/api/children/:id/summary` | PARENT | ✅ 아이 상세 — 집계 · 책별 진행 · 회차별 기록 |
| GET | `/api/books/:id/history` | PARENT | ✅ 이 책에 누가 몇 번 도전했는지 |

집계(`stats`)는 이렇게 센다.

| 필드 | 뜻 |
| --- | --- |
| `booksPassed` | **끝까지 읽은 책 수.** 같은 책을 여러 번 통과해도 한 권 |
| `booksTried` | 도전한 책 수 |
| `attempts` · `completed` · `passed` | 시작한 판 · 끝난 판 · 통과한 판 |
| `retries` | 2회차 이상으로 푼 판 수 |
| `averageScore` | 끝난 판의 평균 점수(정수). 없으면 `null` |

아이 계정은 대시보드를 쓸 수 없다 — 형제의 점수를 보여줄 이유가 없다. 아이는 자기 기록을
`/api/my/attempts` 로 본다.

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
