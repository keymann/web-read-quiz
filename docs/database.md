# 데이터베이스 (Cloudflare D1)

스키마 원문은 `migrations/0001_initial.sql`.

## 관계

```
users(PARENT)
 ├── children ──────────── users(CHILD)   (children.child_user_id, 아이 로그인 계정)
 ├── parent_settings                      (OPENAI_API_KEY 암호문)
 ├── books ── book_sources                (참고 자료 — 서지 API · 웹 검색)
 │     └ book_language · ar_* · lexile   (영문책 읽기 난이도, 0012)
 │     └ cover_rotation                  (표지를 세우기까지 남은 회전량, 0015)
 └── quizzes
      ├── questions
      │    ├── question_versions          ← 불변 스냅샷
      │    ├── question_histories         ← 감사 로그
      │    └── question_validations       ← AI 검증 결과
      └── quiz_assignments ── children
           └── quiz_attempts
                ├── attempt_questions     ← 그 회차에 출제된 20문항 고정
                └── question_answers
```

## 스냅샷 모델 (요구사항 §22 — 방법 A)

문제 본문은 세 곳에 나뉘어 있다.

| 테이블 | 성격 | 언제 쓰나 |
| --- | --- | --- |
| `questions` | **가변**. 최신 상태 캐시 | 부모 검수 화면, 다음 출제 |
| `question_versions` | **불변**. 버전마다 한 행 | 과거 Attempt 재구성 |
| `attempt_questions` | Attempt ↔ version 고정 | 아이가 실제로 본 20문항 |

동작:

1. AI 가 문제를 만들면 `questions` 1행 + `question_versions` version=1 을 함께 쓴다.
2. 부모가 수정하면 `questions` 를 갱신하고 `question_versions` version=2 를 **추가**한다. version=1 은 남는다.
3. 아이가 Attempt 를 시작하면 그 시점 활성 문제 20개의 **최신 version id** 를 `attempt_questions` 에 복사한다.
4. 이후 부모가 문제를 고쳐도 `attempt_questions` 가 가리키는 version 은 그대로다 → **과거 기록 불변**(§21.7·§21.8).

`question_answers` 도 `question_version_id` 와 당시 `correct_choice` 를 함께 저장해, 정답이 수정돼도 과거 채점 결과가 흔들리지 않게 한다.

## 무결성 (§21)

| 조건 | 강제 방법 |
| --- | --- |
| 1. 퀴즈당 활성 문제가 설정한 개수만큼 | `idx_questions_quiz_number_active` 부분 유니크 인덱스 + service 레이어 검사. 개수는 `quizzes.question_count` 에 퀴즈 생성 시점의 설정값이 복사되어 있다(기본 20) |
| 2. `correctChoice` 는 1~4 | `CHECK (correct_choice BETWEEN 1 AND 4)` — `questions` / `question_versions` / `question_answers` 모두 |
| 3. 아이는 자신에게 ASSIGNED 된 퀴즈만 | `quiz_assignments.child_id = principal.childId` 를 모든 쿼리 `WHERE` 에 포함 |
| 4. 다른 아이 퀴즈 조회 불가 | 동일 |
| 5. 부모는 자기 아이 데이터만 | `children.parent_user_id = principal.userId` |
| 6. COMPLETED 이후 문제 변경 불가 | service 의 상태 전이 가드 (`assertEditable()`) |
| 7·8. 과거 Attempt 불변 | 위 스냅샷 모델 |
| 문제 삭제 | 행 삭제가 아니라 `is_active = 0` |
| **책 삭제** | 행까지 지운다. 딸린 열 개 테이블을 순서대로 함께 지운다(아래) |
| 한 Attempt 에 같은 문제 중복 답변 불가 | `idx_question_answers_unique(attempt_id, question_id)` |

SQL 은 전부 D1 prepared statement 의 `.bind()` 파라미터를 쓴다. 문자열 결합으로 쿼리를 만들지 않는다(§26 SQL Injection).

### 책만 행까지 지운다

문항을 감추고 행을 남기는 이유는 과거 풀이 기록이 그 문항을 가리키기 때문이다(§22). 책은
다르다 — 부모가 책장에서 책을 지우는 것은 "이 책을 등록한 일 자체를 없애 달라"는 뜻이고,
그 책의 풀이 기록도 함께 사라져야 한다.

`repositories/books.remove` 가 자식부터 순서대로 지운다.

```
question_answers → attempt_questions → quiz_attempts → quiz_assignments
question_validations → question_histories → question_versions → questions
→ quizzes → book_sources → books
```

스키마에 `ON DELETE CASCADE` 가 있지만 직접 지운다. 외래키 강제 여부에 기대지 않아도 되고,
무엇이 함께 사라지는지가 코드에 적혀 있어야 부모에게 무엇을 지운다고 알릴지도 한 곳에서
정할 수 있다. 열한 문장을 한 `batch` 로 보내므로 왕복은 한 번이고, 중간에 실패하면 전부
되돌아간다. 표지 이미지는 D1 이 아니라 KV 에 있어 **행이 지워진 뒤에** 지운다.

### `web_searched_at` (0017)

웹 자료를 마지막으로 찾은 시각. `searched_at` 과 견주어 **이번 조사에서 이미 찾았는지**를
가린다. 한 번의 조사가 조사 계획을 여러 번 세울 수 있어(릴레이의 모델 교체, 무료 등급 Gemini
키의 내장 검색 429) 그때마다 검색하면 부모가 버튼을 한 번 눌렀는데 크레딧이 두세 번 나간다.

### `web_credits` (0018)

이 책이 지금까지 쓴 웹 검색 크레딧. 책당 상한을 **횟수에서 크레딧으로** 바꾼 값이다
(`MAX_CREDITS_PER_BOOK` = 50). `web_searches` 는 남아 있지만 상한이 아니라 질의 사다리의 칸
번호로만 쓴다.

### `ai_plot` (0019)

조사로 **쌓아 온 줄거리**. "정보 다시 찾기" 를 누를 때마다 새 조사 결과가 여기에 더해진다
(`services/plot.ts` 의 `mergePlot`).

예전에는 이 일을 조사 프롬프트에게 부탁했다 — `[지금까지 정리한 줄거리]` 를 되돌려 주며
"지우지 말고 보강하라" 고 시켰다. 모델은 그 말을 자주 흘렸다. 다시 찾을 때마다 줄거리가 통째로
새 것으로 갈렸고, 이번 자료가 지난 자료보다 얇으면 줄거리는 오히려 짧아졌다.

`brief` 로 대신할 수 없다. 그 안의 `[줄거리]` 절에는 부모가 적은 줄거리(`manual_plot`)도 함께
들어 있어서, 그것을 되돌려 쌓으면 부모가 자기 글을 고쳤을 때 지운 문장이 영영 남는다. AI 가
모은 것과 부모가 적은 것을 따로 두어야 각자 고칠 수 있다.

| | |
| --- | --- |
| 처음 찾을 때 | **손대지 않는다.** 쌓을 것이 없으면 조사 결과가 그대로 들어간다 |
| 더하는 단위 | 문장. 이미 담긴 문장은 버린다(두 글자 조각 겹침 0.7 이상) |
| 지우는 때 | 없다. 조사가 빈손으로 와도 쌓아 둔 것은 그대로 남는다 |
| 상한 | 6,000자. 닿으면 더 붙이지 않고, 쌓아 둔 것을 잘라내지는 않는다 |

이 컬럼이 빈 **옛 행**은 `brief` 의 `[줄거리]` 에서 부모 글을 떼어내 첫 밑감으로 쓴다
(`services/book.ts` 의 `knownPlot`). 그래서 이미 쌓아 둔 책도 다시 찾기에서 잃지 않는다.

### `ai_characters` · `ai_events` (0020)

등장인물과 주요 사건도 같은 규칙으로 쌓는다. 0019 로 줄거리만 쌓게 했더니 **줄거리에 나오는
인물이 목록에서는 빠지는** 일이 생겼다. 세 값은 한 조사가 함께 돌려주므로 함께 쌓아야 한다.

원래 모양(JSON)으로 둔다. `brief` 의 두 절은 사람이 읽을 꼴로 풀어 써 있어, 되읽으려면 그 꼴을
되짚어 뜯어야 한다.

```
ai_characters   [{"name":"잎싹","role":"양계장을 나온 암탉"}, …]
ai_events       ["양계장을 떠난다", "알을 품는다", …]
```

| | |
| --- | --- |
| 등장인물 | 이름으로 같은 사람인지 가리고, 역할은 **더 자세히 적힌 쪽**을 남긴다. 최대 30명 |
| 주요 사건 | **이번 조사가 순서를 정한다.** 그 목록에서 빠진 지난 사건만 뒤에 붙인다. 최대 60개 |

사건만 순서 규칙이 다른 이유는 절 이름이 `[주요 사건 — 일어난 순서]` 이고 그 순서로 순서
문항이 나오기 때문이다. 지난 목록을 앞에 두고 새 사건을 뒤에 붙이면 이야기 앞머리의 사건이
맨 끝에 놓여 순서가 거짓이 된다. 그래서 조사 프롬프트에 지난 사건 목록을 함께 넘겨
(`search/web.ts`) 모델이 한 번에 늘어놓게 하고, 서버는 모델이 흘린 것만 뒤에 붙여 지킨다.

옛 행은 `brief` 의 `[등장인물]`(`- 이름: 역할`)과 `[주요 사건 — 일어난 순서]`(`1. 사건`) 절을
되짚어 첫 밑감으로 쓴다(`services/book.ts` 의 `knownCharacters` · `knownEvents`).

## 시간 표기

모든 시각 컬럼은 ISO8601 UTC 문자열이다. 기본값은 `strftime('%Y-%m-%dT%H:%M:%fZ','now')`.
표시용 시간대 변환은 클라이언트에서 한다.

## 마이그레이션

```bash
npm run db:migrate:local    # .wrangler/state 의 로컬 D1
npm run db:migrate:remote   # 실제 D1
```

스키마 변경은 항상 `migrations/000N_*.sql` 파일 추가로 한다. 기존 마이그레이션 파일은 수정하지 않는다.

## 참고 자료 (`book_sources`)

부모가 문제를 검수하려면 **그 내용이 어디서 왔는지** 볼 수 있어야 한다. 이 표가 그 목록이다.

`source` 컬럼의 값과 화면 순서:

| 순서 | `source` | 성격 |
| --- | --- | --- |
| 1 | `kakao-book` | 카카오 책 검색. 책소개가 가장 길다(실측 250자) |
| 2 | `aladin` | 알라딘 상품 API |
| 3 | `google-books` · `open-library` | 국내 아동서는 거의 잡히지 않는다 |
| 4 | `web` | Tavily 웹 검색으로 실제로 읽은 페이지 |
| 5 | `ai` | 근거가 아니라 **"근거가 없었다"는 기록** |

순서는 `position` 컬럼(0016)이 정한다. `created_at` 으로는 지킬 수 없다 — 한 배치로 넣으면
밀리초까지 같은 값이 박혀 정렬이 사실상 무순서가 된다. 화면은 이 순서를 그대로 따르고,
`web` 은 한 영역으로 묶어 번호를 붙여 보여 준다.

### 줄거리와 관련 없는 자료는 올리지 않는다

Tavily 는 20건을 물어다 주는데 절반 이상이 **판매 페이지·도서관 목록**이다(한국 아동서는 상위
5건이 서점으로 채워진다). 그런 페이지도 제목은 정확히 담고 있어 제목 대조만으로는 걸러지지
않는다. 그래서 참고 자료로 올릴 때 두 가지를 함께 본다(`search/tavily.ts`).

1. **이 책을 다루는가** — 제목 어간 대조 0.8 이상
2. **그 내용을 다루는가** — 발췌 200자 이상이면서 줄거리·주인공·결말 같은 낱말이 둘 이상

거르는 것은 **참고 자료 목록뿐**이다. 프롬프트에 싣는 자료는 줄이지 않는다 — 거기서는 모델이
발췌를 대조해 걸러내고, 판매 페이지의 책소개에서도 줄거리 한 조각은 건질 수 있다.

### 목록도 갈아 끼우지 않고 쌓는다

부모가 실제로 겪은 자리다 — 다시 찾을 때마다 참고 자료 목록이 새로 쓰였다. 웹 자료 묶음
(`web_cache`)은 서버가 쌓지만 그 묶음에는 상한(24건)이 있어 밀려난 자료가 목록에서 사라지고,
모델이 적어 준 출처와 제공자가 알려준 페이지는 애초에 이번 조사 것만 남았다. 지난번에 열어 본
자료가 없어지면 검수를 이어 갈 수 없다.

그래서 `applyResearch` 가 이미 올려 둔 행을 함께 읽어 **자리째** 들고 시작한다.

| | |
| --- | --- |
| 같은 주소 | 자리와 `id` 를 지키고 발췌만 새로 받은 것으로 바꾼다(페이지가 늘어났을 수 있다) |
| 새 주소 | 뒤에 붙인다. 최대 40건, 자리가 차면 올려 둔 것을 밀어내지 않는다 |
| 다른 책 | **지금 제목으로 다시 견준다**(`tavily.aboutBook`). 제목을 고쳐 다시 찾으면 지난 자료는 빠진다 |
| 서지 자료 | 되살리지 않는다 — 이 목록에 올리지 않기로 한 종류다 |
| `ai` 행 | 웹 근거가 생기면 사라진다. 조사가 빈손이면 지난 기록을 그대로 둔다 |

`id` 를 지키는 이유는 화면이 `web` 을 묶어 번호로 보여 주기 때문이다. 부모가 "세 번째 자료" 로
짚어 둔 자리가 조사마다 흔들리면 그 번호로 이야기할 수 없다.
