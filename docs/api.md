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
| PUT | `/api/books/:id/cover` | PARENT | ✅ 브라우저가 돌린 표지로 갈아 끼우기(multipart) |
| POST | `/api/books/:id/orient` | PARENT | ✅ 표지가 누워 있는지 판정 → `coverRotation` |
| POST | `/api/books/:id/analyze` | PARENT | ✅ Vision 으로 제목/저자/출판사/ISBN 추출 |
| POST | `/api/books/:id/search` | PARENT | ✅ 웹 검색으로 책 정보 보강 + `book_sources` 적재 (크레딧을 쓴다) |
| PATCH | `/api/books/:id` | PARENT | ✅ 부모가 책 정보 직접 수정 (AI 오인식 보정) |
| PUT | `/api/books/:id/plot` | PARENT | ✅ 부모가 직접 적은 줄거리 저장 → Brief 재조립 |
| DELETE | `/api/books/:id` | PARENT | ✅ 책과 그 책에서 나온 기록 전부 삭제 |
| DELETE | `/api/books/:id/sources/:sourceId` | PARENT | ✅ 참고 자료 한 건 삭제 (웹 자료 묶음에서도 뺀다) |
| GET | `/api/books/:id/history` | PARENT | 이 책의 퀴즈·풀이 이력 |

### 삭제는 되돌릴 수 없다

문항은 지워도 행이 남는다(`is_active = 0`) — 과거 풀이 기록이 그 문항을 가리키기 때문이다
(§22). 반면 **책은 행까지 지운다.** 부모가 책장에서 책을 지우는 것은 "다른 문제를 내 달라"가
아니라 "이 책을 등록한 일 자체를 없애 달라"는 뜻이다. 잘못 찍은 표지와 남의 책이 목록에 계속
남으면 책장이 못 쓰게 된다.

함께 사라지는 것(`repositories/books.remove` 한 곳에 순서까지 적혀 있다):

```
book_sources · quizzes · questions · question_versions · question_histories
question_validations · quiz_assignments · quiz_attempts · attempt_questions
question_answers · KV 의 표지 이미지
```

스키마에 `ON DELETE CASCADE` 가 걸려 있지만 **직접 순서대로 지운다.** 외래키 강제 여부에
기대지 않아도 되고, 무엇이 함께 사라지는지가 코드에 적혀 있어야 부모에게 무엇을 지운다고
알릴지도 한 곳에서 정할 수 있다. 한 `batch` 라 왕복은 한 번이고, 중간에 실패하면 전부
되돌아간다. 표지(KV)는 **행이 지워진 뒤에** 지운다 — 순서를 바꾸면 D1 삭제가 실패했을 때
표지 없는 책이 책장에 남는다.

화면은 지우기 전에 무엇이 사라지는지 알리고 취소할 기회를 준다(`confirmDialog`). 책 화면에서
지우면 책장으로 돌아간다.

### 참고 자료 한 건 삭제는 묶음까지 건드린다

목록은 조사마다 쌓인다(`collectSources`). 그래서 목록에서만 지우면 다음 "정보 다시 찾기" 가
웹 자료 묶음(`books.web_cache`)에서 그 페이지를 그대로 되살린다. `DELETE :id/sources/:sourceId`
는 행을 지우고 **그 주소를 묶음에서도 뺀다.**

이미 만들어 둔 문제와 Brief 는 건드리지 않는다. 그것은 이 자료를 근거로 부모의 검수를 이미
지난 결과물이고, 자료 한 건을 지우려다 문제까지 잃을 이유가 없다. Brief 의 `[웹 자료]` 절은
**다음 조사에서** 이 자료 없이 다시 조립된다.

### 정보 찾기가 웹 검색까지 맡는다

버튼이 하나다. `POST /api/books/:id/search` 가 서지 조회 · 웹 검색 · AI 조사를 함께 한다.
예전에는 `POST :id/web-search` 가 따로 있었는데, 부모에게는 한 가지 일이라 버튼이 둘이면
어느 것을 눌러야 근거가 늘어나는지 알 수 없었다.

**웹 검색을 다시 돌리는 조건**은 시각 두 개를 견주어 정한다(`shouldSearchWeb`).

웹 검색은 **부모가 이 버튼을 누를 때만** 일어난다. 조사를 시작하는 길이 이 버튼뿐이고,
아이의 재도전은 이미 만들어 둔 Brief 로 문항만 채워 여기까지 오지 않는다.

| 상황 | 웹 검색 |
| --- | --- |
| 첫 조사 (`searched_at` 이 null) | 한 번 한다 |
| 정보 다시 찾기 | 한다. 질의 사다리가 한 칸 올라가고, 찾은 것을 **모아 둔 것에 더한다** |
| 같은 조사 안에서 계획을 다시 세울 때 | **하지 않는다** (`web_searched_at` > `searched_at`) |
| 책당 크레딧(50)을 다 썼을 때 | 하지 않는다. 모아 둔 자료를 쓴다 |

### 책당 상한은 횟수가 아니라 크레딧이다

예전에는 **6회**로 막았다. 두 가지가 어긋났다.

- 한 번의 검색이 1~2 크레딧을 쓴다(basic 1, advanced 2). 횟수로는 실제 소비를 알 수 없다.
- 읽기 난이도 전용 검색도 1 크레딧을 쓰는데 그건 횟수에 세지 않았다.

이제 실제로 잡은 크레딧을 `books.web_credits`(0018)에 쌓고 **50** 으로 막는다. 넉넉히 다시 찾아
근거를 쌓을 수 있으면서(한 번 찾기가 1~3) 한 권이 월 예산을 통째로 먹지 못하는 값이다.
`web_searches` 는 남아 있지만 상한이 아니다 — **질의 사다리의 칸 번호**로 쓴다.

크레딧 수는 `tavily.runQuery` 가 **실제로 잡은 값**을 돌려준다. 깊이로 짐작하면 어긋난다:
키가 소진돼 다음 키로 넘어가면 그만큼 더 잡고, 월 예산이 바닥나 한 번도 못 부르면 0 이다.

세 번째 줄이 `web_searched_at`(0017)이 있는 이유다. 한 번의 조사가 조사 계획을 여러 번
세울 수 있다 — 릴레이는 모델이 응답하지 않으면 다시 받고, 무료 등급 Gemini 키는 내장 검색에
429 를 내서 검색을 끄고 다시 받는다. 그때마다 검색하면 부모가 버튼을 한 번 눌렀는데 크레딧이
두세 번 나간다.

### 남은 크레딧은 Tavily 에게 묻는다

`GET /api/books/:id` 의 `web` 이 그 버튼 옆에 적을 것을 모두 싣는다.

```jsonc
{
  "web": {
    "enabled": true,          // Tavily 키가 하나라도 설정돼 있는가
    "creditsLeft": 3899,      // 이달 서비스 전체가 더 쓸 수 있는 크레딧
    "creditsTotal": 4000,     // 계정마다 물어 합친 한도
    "creditsMeasured": true   // false 면 우리 카운터로 짐작한 값이다
  }
}
```

**책당 검색 횟수(`web_searches`)는 내려보내지 않는다.** 그것은 크레딧이 새지 않게 서버가
잡아 두는 안전장치이고 부모가 조작할 것이 없다. 화면에 "이 책 0 / 6회 남음" 이라고 적어 두면
부모는 그 숫자를 아껴야 하는 것으로 읽고 다시 찾기를 망설인다 — 정작 다시 찾을수록 근거가
쌓인다.

**우리 카운터를 보여 주지 않는다.** 그 값은 막는 데 쓰는 값이라 실제와 어긋난다 — KV 경쟁으로
새고, 이 앱 바깥에서 같은 키를 쓰면 아예 세지 못하고, 실패한 호출에 잡아 둔 크레딧도 돌려주지
않는다. 2026-08-22 실측에서 우리 표시는 한도가 3,800 이라고 했지만 실제 한도는 네 계정 ×
1,000 = **4,000** 이었고 그때까지 쓴 것은 101 크레딧이었다.

그래서 `GET https://api.tavily.com/usage` 로 계정마다 묻는다. 이 호출은 **크레딧을 쓰지
않는다**(같은 키로 세 번 불러 `usage` 가 움직이지 않는 것을 확인했다). 다만 실측 1.0~1.6초가
걸려서 **응답을 붙잡지 않는다** — 들고 있던 값을 바로 내주고, 5분보다 묵었으면 `waitUntil` 로
뒤에서 다시 묻는다. 한 번도 못 물어본 상태에서만 카운터로 짐작한 값이 나가고, 그때는
`creditsMeasured` 가 false 다.

남은 크레딧은 **버튼을 누를 수 있든 없든 늘 보인다.** 예전에는 버튼 옆 안내 문구에 섞여
있어서 정작 한도가 걸려 잠긴 순간에 사라졌다 — 부모가 "얼마나 남았나"를 가장 알고 싶은
때가 그때다.

### 표지 방향 — 판정은 서버, 회전은 브라우저

부모는 책을 손에 들고 찍는다. 폰을 가로로 들거나 책을 눕혀 두고 찍으면 **제목이 옆으로 누운
사진**이 등록된다. EXIF 방향은 브라우저가 이미 바로잡지만 그건 "폰이 어떻게 들렸는가" 일 뿐,
책이 어느 쪽으로 누웠는가는 아니다. 가로세로 비율로도 알 수 없고, 90°인지 270°인지는 글자를
봐야만 안다. 그래서 **모델이 사진을 본다**(`POST :id/orient`, 스키마는 각도와 확신 둘뿐이다).

돌리는 일은 서버가 못 한다 — Workers 런타임에는 이미지 디코더가 없다. 그래서 두 쪽이 나눈다.

```
POST /api/books/:id/orient   →  { rotation: 90 }        서버: 각도를 판정해 적어 둔다
                                (브라우저가 canvas 로 돌린다)
PUT  /api/books/:id/cover    →  { book: { … } }         서버: 검증 후 갈아 끼우고 rotation = 0
```

`book.coverRotation` 의 값:

| 값 | 뜻 |
| --- | --- |
| `null` | 아직 확인하지 않았다 — 화면이 열릴 때 한 번 판정을 건다 |
| `0` | 똑바로 서 있다 |
| `90` · `180` · `270` | 이만큼 시계 방향으로 더 돌려야 한다 (브라우저가 아직 못 돌렸다) |

기본값이 `null` 이므로 **이 기능 전에 등록해 둔 책도** 부모가 그 책을 열어 보는 순간 한 번
판정을 거쳐 바로 선다. 판정은 책 한 권에 한 번뿐이다 — 결과가 0 이든 90 이든 컬럼이 채워지면
다시 묻지 않는다. 서지 식별(`analyze`)에 얹지 않고 따로 둔 이유가 여기 있다. 이미 등록된 책의
방향을 확인하려고 식별을 다시 돌리면 부모가 손으로 고쳐 둔 지은이·출판사가 AI 값으로 덮인다.

`coverUrl` 에는 갱신 시각이 붙어 나간다(`?v=…`). 표지 바이트가 **같은 KV 키 위에서 바뀌기**
때문에, 주소가 그대로면 `private, max-age=3600` 캐시가 돌리기 전 사진을 계속 보여 준다.

`GET /api/books/:id` 의 `book` 에는 **영문책의 읽기 난이도**가 함께 실린다.

```jsonc
{
  "language": "en",              // 책이 쓰인 말(ISO 639-1). 퀴즈의 language 와 다르다
  "readingLevel": {              // 하나도 못 알아냈으면 null
    "source": "web",             // web = 실제 페이지에서 읽음 · ai = 모델이 짐작함
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

### 못 찾았을 때 — AI 가 짐작한다

전용 검색이 빈손이면 **조사 모델이 짐작한 값**으로 채우고 `source: "ai"` 로 표시한다.
AR·Lexile 이 아예 매겨지지 않았거나 잘 알려지지 않은 책이 흔해서, 없는 것보다는 낫다.

값은 **이미 도는 조사 호출에 얹어** 받는다. 따로 부르지 않으므로 비용도 지연도 늘지 않고,
서버 경로와 브라우저 릴레이가 같은 길을 탄다.

**섞지 않는다.** 웹에서 하나라도 찾았으면 짐작으로 채우지 않는다 — 한 줄에 확인된 값과
짐작한 값이 섞이면 부모가 어느 쪽이 어느 쪽인지 알 수 없다.

화면은 `source: "ai"` 일 때 **"AI가 추측한 등급"** 배지를 달고, 태그를 점선·주황으로 바꾸고,
`arbookfind.com`·`lexile.com` 에서 확인하라고 안내한다. 부모가 이 숫자로 책을 고르므로
확인된 값과 똑같이 보이면 안 된다.

## 브라우저 릴레이 (Gemini 전용 · PARENT)

| Method | Path | 설명 |
| --- | --- | --- |
| GET | `/api/ai/credential` | ✅ 브라우저가 쓸 Gemini 키·모델. **제공자가 gemini 일 때만** |
| POST | `/api/ai/plan` | ✅ `{kind, …}` → 브라우저가 그대로 보낼 요청 |
| POST | `/api/ai/apply` | ✅ 브라우저가 받아 온 Gemini 원본 응답을 서버가 해석·반영 |

`kind` — plan: `identify` · `research` · `generate` · `validate` / apply: `identify` · `research` · `accept`

**문제 생성·검증은 요청이 배열로 오간다.** `generate`·`validate` 의 plan 은 `{url, body}` 대신
`calls: [{url, body}, …]` 를 돌려주고, 브라우저가 받은 응답들을 `responses: […]` 로 되돌려준다.
`validate` plan 이 응답을 합치면서 **번호를 다시 매기고**, 그 번호를 `accept` 까지 쓴다 —
번호가 검수 결과를 문항에 잇는 열쇠라 청크마다 1번부터 매겨 오는 것을 그대로 두면 안 된다.

**다만 지금 릴레이는 나누지 않는다(`RELAY_MAX_PARALLEL = 1`).** 서버 경로는 셋으로 나누는데
여기만 다른 이유는 실측이다 — 2026-08-18, Gemini 무료 등급 키·20문항 기준:

| | 결과 |
| --- | --- |
| 한 덩어리로 | 생성 82초 → 전체 207초 |
| 셋으로 나눠 동시에 | `429`·`503` 이 돌아와 재시도·모델 교체로 번짐. 198초에도 생성 중 |

릴레이는 **부모의 키로 브라우저가 직접** 부르는 경로라 무료 등급의 동시 호출 제한을 그대로
맞는다. 배열 구조는 남겨 두었다 — 견디는 키를 가려내거나 호출에 시차를 두는 방식을 붙이면
숫자만 올리면 된다. 책 식별·조사는 호출이 하나뿐이라 예전 모양 그대로다.

### 호출을 언제 끊는가

브라우저의 Gemini 호출에는 세 가지 신호가 함께 걸린다.

| 신호 | 값 | 왜 |
| --- | --- | --- |
| 호출별 타임아웃 | 180초 | 응답이 오지 않으면 영원히 기다리게 된다. 서버 경로도 같은 값 |
| 단계 데드라인 | 6분 | 없으면 최악이 `3회 재시도 × 3모델 × 180초 = 27분` |
| 취소 | 부모가 누를 때 | **돌고 있는 호출을 곧바로 끊는다** |

끊긴 호출은 다시 걸지 않고 모델도 바꾸지 않는다 — 어느 쪽도 상황을 바꾸지 못한다.
취소로 끊긴 것은 실패로 치지 않으며, 그때까지 저장된 문항은 그대로 남는다.

서버 경로는 백그라운드 작업이라 밖에서 끊을 수 없어, 취소해도 돌고 있는 호출이 끝난 뒤에
멈춘다. 두 경로의 차이는 여기뿐이다.

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
| DELETE | `/api/quizzes/:id` | PARENT | ✅ 회차 삭제 → 남은 회차 번호 재배정. 생성 중이면 **409** |
| GET | `/api/books/:id/quizzes` | PARENT | ✅ 이 책의 퀴즈 회차 목록 |
| PATCH | `/api/questions/:id` | PARENT | 문제 수정 → version+1, history=PARENT_EDITED |
| GET | `/api/questions/:id/history` | PARENT | 문제 변경 이력 |
| POST | `/api/quizzes/:id/approve` | PARENT | 검증 후 status=APPROVED |

### 회차를 지우면 번호를 다시 매긴다

`DELETE /api/quizzes/:id` 는 그 회차의 문항과 아이의 도전 기록까지 지운다(`quizzes.remove` 한
곳에 순서까지 적혀 있다). 그러고 나서 남은 회차에 **만든 순서대로 1번부터 다시 번호를 매긴다**
(`renumberRounds`). 번호에 구멍이 나면 부모는 잃은 회차를 찾게 되고, 다음 회차 번호
(`nextRound` = 최댓값 + 1)도 그 구멍만큼 앞서 나간다.

**만드는 중(`GENERATING`)인 회차는 409 로 막는다.** 백그라운드 작업은 밖에서 죽일 수 없어
(`cancel` 은 표시만 남긴다), 행을 먼저 지우면 그 작업이 지워진 회차에 문항을 계속 써 넣는다.
멈추고 나서 지운다.

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
