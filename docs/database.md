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
| 한 Attempt 에 같은 문제 중복 답변 불가 | `idx_question_answers_unique(attempt_id, question_id)` |

SQL 은 전부 D1 prepared statement 의 `.bind()` 파라미터를 쓴다. 문자열 결합으로 쿼리를 만들지 않는다(§26 SQL Injection).

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
