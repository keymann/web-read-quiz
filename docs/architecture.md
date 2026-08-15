# 아키텍처

## 배치

```
                    브라우저 (모바일 / 태블릿 / PC)
                              │
                              │ HTTPS, HttpOnly Cookie
                              ▼
            ┌─────────────────────────────────────────┐
            │      Cloudflare Worker (단일 배포)       │
            │                                         │
            │  /api/*   → routes → services → repos   │
            │  그 외    → ASSETS (public/ 정적 SPA)   │
            └───┬───────────┬───────────┬─────────────┘
                │           │           │
                ▼           ▼           ▼
               D1      KV(SESSIONS)   KV(IMAGES)     → OpenAI / Gemini
        (관계형 데이터)  (세션·RateLimit)  (책 표지)      (Worker 에서만 호출)
```

프론트엔드와 API 를 **같은 Worker, 같은 오리진**에서 서빙한다. 그 결과:

- CORS 설정이 필요 없다.
- 세션 쿠키에 `__Host-` 프리픽스를 걸 수 있어 CSRF 방어가 단순해진다.
- 배포가 `wrangler deploy` 한 번이다.

레퍼런스 프로젝트(`low-grade-operator-exercise-web`)와 동일하게 **빌드 단계가 없다.**
`public/` 의 파일이 그대로 브라우저로 전달되며, 화면 코드는 네이티브 ES module 로 나눈다.

## 레이어

요구사항 §31 에 따라 Worker 내부를 다음 레이어로 분리한다. 위 레이어는 아래만 호출하고, 역방향 의존은 만들지 않는다.

| 레이어 | 위치 | 책임 |
| --- | --- | --- |
| routes | `src/routes/` | HTTP 파싱, 입력 검증, 인증/인가 확인, 응답 직렬화 |
| services | `src/services/` | 도메인 규칙 (퀴즈 상태 전이, 채점, 재도전 쿨다운, 스냅샷) |
| repositories | `src/repositories/` | D1 접근. **SQL 은 이 레이어 밖으로 나가지 않는다** |
| ai | `src/ai/` | OpenAI 호출 (Vision 식별, 문제 생성, 문제 검증) |
| search | `src/search/` | 책 정보 웹 검색 + 공개 서지 API |
| auth | `src/auth/` | 세션 발급/검증, 비밀번호 해시, 권한 가드 |
| utils | `src/utils/` | 응답 포맷, 에러, ID 생성, 암복호화, Rate Limit |

## 인증

- 비밀번호는 PBKDF2-SHA256(100,000회, 사용자별 salt)으로 해시한다. Workers 런타임에 bcrypt/argon2 가
  없어 WebCrypto 만으로 처리하며, 반복 횟수를 저장 포맷에 담아 나중에 값을 올려도 기존 해시를 계속 검증한다.
- 로그인 성공 시 HS256 서명 토큰을 쿠키로 내려준다.
  `HttpOnly; Secure; SameSite=Lax; Path=/`
  - HTTPS 에서는 `__Host-session`, 로컬 http 개발에서는 `session` 이름을 쓴다.
    `__Host-` 프리픽스가 `Secure` 를 요구해 http 에서는 붙일 수 없기 때문이다. 읽을 때는 두 이름을 모두 확인한다.
  - `SameSite=Strict` 가 아니라 `Lax` 인 이유: Strict 면 외부 링크로 앱에 처음 들어올 때 쿠키가 실리지 않아
    로그아웃된 것처럼 보인다. 크로스 사이트 POST 는 Lax 로도 막히고, 그 위에 Origin 검사가 한 겹 더 있다.
- 토큰의 `jti` 를 KV(`session:<jti>`)에 TTL(14일)과 함께 저장한다. 로그아웃/강제 만료는 KV 키 삭제로 처리한다.
- 매 요청마다 **사용자 행이 아직 존재하고 활성 상태인지** 확인한다. 이 확인이 없으면 부모가 아이를
  삭제해도 그 아이가 이미 들고 있던 로그인이 토큰 만료(14일)까지 살아 있다. 확인에 실패하면 KV
  세션 레코드도 함께 지워 다음 요청은 D1 까지 가지 않는다. role·표시이름도 토큰이 아니라 이 행에서 읽는다.
- 모든 `/api/*` 요청은 쿠키에서 신원(`Principal`)을 복원한다.
  **클라이언트가 body/query 로 보낸 `parentId`·`childId` 는 어떤 경우에도 신뢰하지 않는다.**
- 변경 요청(POST/PATCH/DELETE)은 `Origin` 헤더가 자기 오리진과 일치하는지 추가로 확인한다.
- 로그인 실패 응답은 "아이디 없음"과 "비밀번호 틀림"을 구분하지 않고, 아이디가 없어도 더미 해시로
  검증 시간을 소모해 존재 여부가 응답 시간으로 새지 않게 한다.

## 보안 헤더

정적 자산은 **Worker 를 거치지 않고 자산 서버가 바로 응답한다.** 따라서 CSP 등 문서 보안 헤더는
Worker 코드가 아니라 `public/_headers` 에 둔다. API(JSON) 응답에는 `X-Content-Type-Options: nosniff` 를
`src/utils/response.ts` 가 항상 붙인다.

CSP 는 `default-src 'self'` 기반이며 인라인 스크립트·인라인 스타일을 허용하지 않는다.
그래서 화면 코드는 `style="..."` 속성을 쓰지 않고 클래스만 쓴다.

## 권한 가드

`src/auth/guards.ts` 가 라우트 진입 시점에 소유권을 확인한다.

- `requireParent()` — role 이 PARENT 인지
- `requireOwnedChild(childId)` — `children.parent_user_id = principal.userId`
- `requireOwnedQuiz(quizId)` — `quizzes.parent_user_id = principal.userId`
- `requireAssignedToChild(assignmentId)` — `quiz_assignments.child_id = principal.childId`

리포지토리 쿼리에도 소유자 컬럼을 `WHERE` 에 항상 포함해, 가드를 빠뜨려도 남의 데이터가 조회되지 않게 이중으로 막는다.

## OpenAI 호출 경계

API Key 는 **부모가 설정 화면에서 직접 입력**한다(§25). 저장 방식:

1. 저장 **전에** OpenAI `GET /v1/models` 로 키가 실제로 동작하는지 확인한다
2. `ENCRYPTION_KEY`(Worker Secret, base64 32바이트) 기반 AES-GCM 으로 암호화. IV 는 매번 새로 뽑아
   같은 키를 다시 저장해도 암호문이 달라진다
3. `parent_settings.openai_api_key_cipher` + `..._iv` 에 저장, 뒤 4자리만 별도 컬럼에 평문 보관
4. 조회 API 는 `{ configured: true, last4: "abcd" }` 만 반환. **복호화된 키는 절대 응답에 담지 않는다**

복호화된 키가 나가는 통로는 두 곳뿐이다.
- `src/services/settings.ts` 의 `getRuntime` — AI 서비스가 서버에서 호출할 때
- `src/services/relay.ts` 의 `credential` — **브라우저 릴레이 전용** (아래 참고)

## 브라우저 릴레이 (Gemini 전용)

AI Studio 의 Gemini API 는 요청을 보낸 **서버**의 위치를 보고 막는다. Cloudflare Worker 는
홍콩 콜로(`cf-ray … -HKG`)에서 나가는데 홍콩은 Gemini 미지원 지역이다. 부모의 브라우저는
지원 지역에 있으므로, Gemini 를 쓰는 경우에만 브라우저가 대신 호출한다.

```
브라우저 ──①요청 만들어 줘──▶ Worker    (프롬프트·스키마·이미지까지 완성된 본문)
        ◀─②{url, body}────
        ──③본문 + 내 키 ───▶ Gemini
        ◀─④원본 응답──────
        ──⑤응답 그대로 ────▶ Worker    (파싱·사후검사·임계값·저장은 서버)
```

**브라우저는 요청을 만들지도, 결과를 판정하지도 않는다.** 프롬프트·스키마가 클라이언트로
복사되지 않고, 품질 게이트(§7·§9·§10 사후검사, 검증 임계값, 정답 위치 균등화)도 서버에 남는다.
클라이언트가 조작한 문항을 보내도 저장 직전에 사후검사를 한 번 더 돌린다.

이 경로에 건 조건:

| 조건 | 구현 |
| --- | --- |
| 키는 PARENT 세션에만 | `GET /api/ai/credential` 이 `requireParent` + 제공자 확인 |
| 제공자가 gemini 일 때만 | OpenAI·Vertex 는 403. 서버가 부를 수 있으므로 내려보낼 이유가 없다 |
| 브라우저에 저장하지 않음 | 작업 시작 시 받아 지역 변수로만, 끝나면 참조를 끊는다 |
| CSP 최소 완화 | `connect-src` 에 `generativelanguage.googleapis.com` 하나만 추가 |

### 키 등록도 브라우저가 한다

서버가 Gemini 를 **한 번도** 부를 수 없다는 것은 키 검증과 모델 목록 조회에도 똑같이
적용된다. 서버가 검증하려 들면 키를 아예 등록할 수 없다. 그래서 Gemini 는

1. 브라우저가 입력받은 키로 모델 목록을 직접 조회한다 (조회 성공 = 키 유효)
2. `PUT /api/settings/ai-key` 에 키와 **목록을 함께** 보낸다
3. 서버는 받은 목록을 자기 기준으로 거르고 정렬한 뒤(`normalizeModels`) 저장한다

목록을 누가 가져왔든 *무엇을 쓸 수 있고 무엇이 먼저인지* 는 서버가 정한다. 조작된 목록을
보내도 못 쓰는 모델이 기본값이 되지 않는다.

거른 목록은 `parent_settings.available_models` 에 남긴다. 서버가 다시 물어볼 수 없기 때문에,
설정 화면의 모델 선택지와 **모델 폴백 후보**가 모두 이 값에서 나온다.

### 실패했을 때도 모델은 서버가 고른다

Gemini 는 인기 모델이 자주 `503 UNAVAILABLE`(과부하) 이나 `429 RESOURCE_EXHAUSTED`(모델별
한도)를 낸다. 과부하는 잠깐 기다렸다 세 번까지 다시 부르고, 한도는 기다려도 안 풀리므로
바로 넘어간다. 그래도 안 되면 **"이 모델은 응답하지 않더라" 만** `avoid` 로 알려준다. 다음에
무엇을 쓸지는 서버가 정하고(`chooseModel`), 후보가 떨어지면 서버가 거절한다. 서버 호출
경로의 `withModelFallback` 과 같은 역할·같은 한도(최대 3개)다.

> 이 구조는 요구사항 §24(`Frontend → AI API` 금지)와 어긋난다. Gemini 를 배포 환경에서
> 쓰려면 이것 말고는 Vertex AI(서비스 계정) 또는 지원 지역 프록시 자체 운영뿐이라, 셋 중
> 하나를 고른 결과다. 키를 보게 되는 것은 **그 키를 등록한 부모 본인**이다.

DB 가 통째로 유출돼도 `ENCRYPTION_KEY` 없이는 키를 복원할 수 없다.

## 백그라운드 생성

20문제 생성 + 검증은 수십 초가 걸린다. 요청을 붙잡고 있지 않는다.

```
POST /api/quizzes/:id/generate
  → quizzes.status = 'GENERATING' 로 전이하고 202 즉시 응답
  → ctx.waitUntil(pipeline)  으로 생성 파이프라인 실행
  → 완료 시 status = 'REVIEW', 실패 시 status = 'DRAFT' + generation_error

GET /api/quizzes/:id   (클라이언트가 2초 간격 폴링)
  → { status, progress: { generated, validated, total } }
```

`waitUntil` 이 시간 초과되는 사례가 나오면 Cloudflare Queues 로 옮긴다(계획 §리스크 참고).

### 다시 만들기가 아니라 채우기다

`generate` 는 **남아 있는 활성 문항을 건드리지 않고 빈 자리만 채운다.** 예전에는 시작할 때
전부 비활성화했는데, 그러면 부모가 3번 문제 하나만 다시 만들려고 해도 나머지가 통째로
새로 만들어진다 — 애써 확인한 문항이 사라지고 비용도 그만큼 든다.

지울 문항은 부모가 검수 화면에서 고르고(`POST /api/quizzes/:id/regenerate`), 생성은 채우기만
한다. 브라우저 릴레이 경로(`relay.planGenerate`)도 원래 같은 규칙이었다 — 두 경로가 서로 다르게
동작하던 것을 맞춘 것이기도 하다.

번호는 이어 붙이지 않고 **비어 있는 가장 작은 번호부터** 채운다(`generation.freeNumbers`).
활성 문항 안에서 `question_number` 는 유일해야 하므로, 이어 붙이면 3번을 비운 자리에 5번을
만들려다 부딪힌다.

## 참고 자료(출처) 적재

부모가 문제를 검수하려면 근거를 볼 수 있어야 한다. 그런데 참고 자료가 통째로 비는 경우가
잦았다 — 서지 API 가 한국 아동서를 모르고, 무료 등급 키는 웹 검색을 쓸 수 없고, 검색을 쓴
경우에도 모델이 `sources` 를 자주 비워서 보낸다.

그래서 얻은 것이 적어도 **출처는 반드시 남긴다**(`book.collectSources`).

| `book_sources.source` | 무엇 |
| --- | --- |
| `google-books` · `open-library` | 공개 서지 API 가 답한 것 |
| `web` | 모델이 적어 준 출처 + 제공자가 알려준 그라운딩 페이지(같은 URL 은 한 번만) |
| `ai` | 웹 근거가 하나도 없었다는 기록. "이 내용은 모델 기억에서 나왔다" |

Gemini 는 모델이 `sources` 를 비워도 응답에 `groundingMetadata` 가 붙어 온다
(`extractGroundingSources`). 무엇을 보고 답했는지는 거기서 확실히 알 수 있다.

`ai` 출처는 **근거로 세지 않는다**(`book.evidenceCount`). 그것까지 세면 근거가 하나도 없을 때
오히려 "근거 얇음" 경고가 사라진다.

## 문제 언어

책이 한국어여도 문제는 영어로 낼 수 있다(영어 독해 겸용). 기본값은 **영어**다.

- 부모 설정의 기본값 → `parent_settings.question_language`
- 퀴즈를 만들 때 그 판만 바꿀 수도 있다 → `POST /api/quizzes` 의 `language`
- 고른 값은 `quizzes.language` 로 **복사된다**. 나중에 설정을 바꿔도 이미 만든 퀴즈의 언어는
  그대로여야 하고, 부족한 문항을 채울 때 언어가 섞이면 안 되기 때문이다

프롬프트와 책 정보는 한국어로 주고 **출력만** 해당 언어로 받는다. 지시를 통째로 영어로 바꾸면
§9 의 12개 조건 문구를 옮겨야 하는데 그 문구는 요구사항에서 그대로 온 것이라 건드리지 않는
편이 안전하다. 언어가 섞인 문항은 사후검사로 잡기 어려워 AI 검수자에게 맡긴다.

## 아이가 푸는 판 (Attempt)

Attempt 를 시작할 때 그 시점의 활성 문항을 **버전 단위로 고정한다**(`attempt_questions`).
이후 부모가 문제를 고치거나 지워도 진행 중인 판은 흔들리지 않고, 이력을 볼 때도 "그때 본
문항" 이 그대로 재구성된다(§22). 본문·선택지·정답을 모두 `question_versions` 에서 읽는다 —
`questions` 를 읽으면 나중에 고친 내용이 과거에 섞인다.

세 가지 규칙이 서비스의 전부다.

1. **정답은 안 푼 문항에서 뺀다.** 응답에 담기기만 해도 개발자 도구로 볼 수 있다. 채점은
   서버가 하므로 클라이언트가 알아야 할 이유가 없고, 답한 뒤에는 그때 담아 준다(§15 즉시 채점).
2. **한 문제는 한 번만.** 되돌아가 볼 수는 있어도 다시 답할 수는 없다. 서비스가 확인하고
   `question_answers(attempt_id, question_id)` 유니크 인덱스가 한 번 더 막는다.
3. **통과 기준을 채우면 그 자리에서 끝낸다**(§15 조기 종료). 남은 문항은 미응답으로 남는다.

점수는 `round(정답 수 / 통과 기준 × 100)`, 최대 100. 문항 수 대비 백분율이 아니라 **통과 기준
대비 진척도**다 — 요구사항 §17 의 예시(20문항/10통과에서 10개 → 100점, 8개 → 80점)가 그렇고,
부모가 문항 수를 바꿔도 같은 의미가 유지된다.

집계(`correct_count`·`wrong_count`)는 답을 넣는 것과 **같은 배치**에서 올린다. 따로 계산해
UPDATE 하면 두 번 눌렀을 때 두 번 더해진다. 유니크 인덱스가 두 번째 INSERT 를 막으면 배치
전체가 롤백되어 집계도 오르지 않는다.

## 진행 상황 알리기

생성 한 번이 30초를 넘기는 일이 흔하다. "만드는 중" 한 줄만 띄워 두면 그 시간 내내 멈춘 것처럼
보이고, 실제로 새로고침해서 중단시키는 일이 생긴다(릴레이 경로에서는 탭이 곧 실행 주체다).

- 서버 경로: 2초 폴링 + 경과 시간을 1초마다 다시 그린다
- 릴레이 경로: **긴 호출을 보내기 전에** 무엇을 하려는 참인지 알린다
  (`준비 → 문제 N개 만드는 중 → 규칙 검사 → M개 검수 중 → 저장`), 재시도·모델 교체도 그때그때
  알린다. `runStep` 의 `onPlan`·`onNote` 가 그 통로다.
