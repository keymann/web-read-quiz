# AI 독서 퀴즈

고학년 초등학생이 책을 **실제로 읽었는지** 확인하는 AI 독서 퀴즈 웹앱.

부모가 책 표지를 촬영하면 AI 가 책을 식별하고 웹에서 정보를 모아
**책을 읽어야만 풀 수 있는 4지선다 20문제**를 만든다. 부모가 검수해서 아이에게 제출하면,
아이가 문제를 풀고 20문제 중 10문제 이상 맞히면 통과한다.

단순한 문제 생성기가 아니라 **아이 → 책 → 퀴즈 → 답안 → 점수 → 통과 여부**를 장기간 축적하는
독서 관리 서비스를 목표로 한다.

## 구조

Cloudflare Worker 하나가 API 와 정적 SPA 를 함께 서빙한다. **빌드 단계가 없다.**

```
src/                Worker (TypeScript, strict)
  index.ts          라우터 진입점
  routes/           HTTP 계층
  services/         도메인 규칙
  repositories/     D1 접근 (SQL 은 여기서만)
  ai/               OpenAI 호출
  search/           책 정보 검색
  auth/             세션 · 권한
  utils/            응답 · 암호화 · Rate Limit
public/             SPA (네이티브 ES module, 번들러 없음)
  index.html
  styles.css        green 디자인 토큰
  js/
migrations/         D1 스키마
docs/               설계 문서
```

바인딩: **D1**(`DB`) · **KV**(`SESSIONS` 세션/RateLimit, `IMAGES` 책 표지) · **ASSETS**(정적 자산)

AI 호출은 **전부 Worker 안에서만** 일어난다. API Key 는 클라이언트로 나가지 않는다.

AI 제공자는 부모가 셋 중에 고른다.

| 제공자 | 자격증명 | 배포 환경 | 비고 |
| --- | --- | --- | --- |
| **OpenAI** | API Key (`sk-…`) | ✅ | 결제 수단 필요 |
| **Google Gemini** | API Key (AI Studio) | ❌ | 무료 등급 가능하지만 **로컬 개발 전용** |
| **Google Vertex AI** | 서비스 계정 JSON | ✅ | 같은 Gemini 모델, GCP 결제 계정 필요 |

> ⚠️ AI Studio 의 Gemini 키는 **배포 환경에서 쓸 수 없다.** Google 이 요청을 보낸 서버의 위치를
> 보고 막는다(`FAILED_PRECONDITION: User location is not supported`). 같은 키라도 로컬에서는 잘
> 동작한다. 배포된 서비스에서 Gemini 모델을 쓰려면 **Vertex AI** 를 고르면 된다.
> 자세한 내용은 [docs/plan.md](docs/plan.md) 의 Phase 3.5·3.6 참고.

## 문서

| 문서 | 내용 |
| --- | --- |
| [docs/plan.md](docs/plan.md) | **개발 계획 — Phase 0~9, 요구사항 해석, 리스크** |
| [docs/architecture.md](docs/architecture.md) | 배치, 레이어, 인증, 권한 가드 |
| [docs/database.md](docs/database.md) | 스키마, 스냅샷 모델, 무결성 조건 |
| [docs/api.md](docs/api.md) | 엔드포인트, 에러 코드, Rate Limit |
| [docs/ai-question-generation.md](docs/ai-question-generation.md) | 문제 생성 6단계 파이프라인 |

## 로컬 개발

```bash
npm install
cp .dev.vars.example .dev.vars     # 값을 채운다 (아래 참고)
npm run db:migrate:local           # 로컬 D1 에 스키마 적용
npm run dev                        # http://localhost:8787
```

`wrangler dev` 는 D1 · KV 를 모두 로컬(Miniflare)로 시뮬레이션한다.
`wrangler.jsonc` 의 placeholder ID 그대로도 로컬 개발이 된다.

`.dev.vars` 값 생성:

```bash
openssl rand -base64 48     # SESSION_SECRET
openssl rand -base64 32     # ENCRYPTION_KEY
```

기타 명령:

```bash
npm run check        # tsc --noEmit + wrangler deploy --dry-run
npm test             # vitest (@cloudflare/vitest-pool-workers)
npm run cf-typegen   # wrangler.jsonc 변경 후 Env 타입 재생성
```

## Cloudflare 배포

### 1. 리소스 생성 (최초 1회)

```bash
npx wrangler d1 create web-read-quiz
npx wrangler kv namespace create SESSIONS
npx wrangler kv namespace create IMAGES
```

출력된 ID 로 `wrangler.jsonc` 의 값을 교체한다.

- `d1_databases[0].database_id`
- `kv_namespaces[].id` (SESSIONS · IMAGES)

표지 이미지는 KV(`IMAGES`)에 담는다. 원래 R2 를 쓰려 했으나 R2 는 계정에서 따로 활성화해야 해서
(결제 수단 등록 필요) KV 로 갔다. 업로드가 긴 변 1024px·JPEG 0.72 로 줄여 들어오므로 보통
100~300KB 이고, KV 값 상한 25MB 에 한참 못 미친다. **공개 접근은 불가능하며**
`/api/books/:id/cover` 가 소유권을 확인한 뒤에만 내보낸다.

### 2. Secret 등록

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put INVITE_CODE      # 선택
```

AI API Key 는 Secret 이 아니다. **부모가 앱의 설정 화면에서 직접 입력**하고,
서버가 AES-GCM 으로 암호화해 D1 에 저장한다. 설정 화면에 제공자별 키 발급 방법이 안내되어 있다.

### 3. 마이그레이션 + 배포

```bash
npm run db:migrate:remote
npm run deploy
```

`wrangler.jsonc` 를 고친 뒤에는 `npm run cf-typegen && npm run check` 로 확인하고 배포한다.

## 저작권

책 원문을 수집하거나 저장하지 않는다. 공개된 책 소개·줄거리·서평 등
합법적으로 접근 가능한 정보만 출처 URL 과 함께 발췌해 활용한다.
