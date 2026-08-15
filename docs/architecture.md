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
               D1          R2          KV            → OpenAI API
          (관계형 데이터)  (표지 이미지)  (세션/RateLimit/캐시)   (Worker 에서만 호출)
```

프론트엔드와 API 를 **같은 Worker, 같은 오리진**에서 서빙한다. 그 결과:

- CORS 설정이 필요 없다.
- 세션 쿠키를 `SameSite=Strict` + `__Host-` 프리픽스로 걸 수 있어 CSRF 방어가 단순해진다.
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

1. 입력받은 키를 `ENCRYPTION_KEY`(Worker Secret) 기반 AES-GCM 으로 암호화
2. `parent_settings.openai_api_key_cipher` + `..._iv` 에 저장, 뒤 4자리만 별도 컬럼에 평문 보관
3. 조회 API 는 `{ configured: true, last4: "abcd" }` 만 반환. **복호화된 키는 절대 응답에 담지 않는다**

AI 호출이 필요한 시점에만 서버에서 복호화해 `Authorization` 헤더로 사용한다.

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
