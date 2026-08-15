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
