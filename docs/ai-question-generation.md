# AI 문제 생성 파이프라인

## 호출 횟수 예산 (§28)

퀴즈 1개당 **정상 경로에서 OpenAI 호출 4회**를 목표로 한다.

| # | 단계 | 호출 | 입력 | 출력 |
| --- | --- | --- | --- | --- |
| 1 | 책 식별 | Vision 1회 | 표지 이미지 | `{title, author, publisher, isbn, confidence}` |
| 2 | 책 정보 검색 | `web_search` 1회 | 1의 결과 + ISBN | 서지정보 + 줄거리 + 출처 배열 |
| 3 | 정보 정리 | **호출 없음** | 2의 structured output 재사용 | Book Brief |
| 4 | 20문제 생성 | 1회 | Book Brief | 문제 20개 |
| 5 | 전체 검증 | 1회 | 문제 20개 | 검증 결과 20개 |
| 6 | 실패분 재생성 | 필요 시 1회 | 실패 문제 + 기존 19문항 요약 | 대체 문제 N개 |

**20문제를 통째로 다시 만들지 않는다.** 6단계는 실패한 문항 수만큼만 요청하고, 5로 돌아가 재검증한다.
재시도는 최대 3라운드. 3라운드 후에도 20개를 못 채우면 채운 만큼 REVIEW 로 넘기고
`generation_error` 에 사유를 남겨 부모가 수동 재생성할 수 있게 한다.

## 1단계 — 책 식별 (Vision)

이미지는 R2 원본이 아니라 **긴 변 1024px 로 축소한 사본**을 보낸다(토큰 절감).

Structured Output 스키마:

```json
{
  "type": "object",
  "properties": {
    "title":      { "type": "string" },
    "author":     { "type": "string" },
    "publisher":  { "type": "string" },
    "isbn":       { "type": "string" },
    "confidence": { "type": "number" }
  },
  "required": ["title", "author", "publisher", "isbn", "confidence"],
  "additionalProperties": false
}
```

읽을 수 없는 항목은 빈 문자열로 채우게 하고, 추측해서 지어내지 말라고 명시한다.
`confidence < 0.6` 이면 부모에게 "책 정보를 직접 확인해 주세요" 화면을 띄운다.

## 2단계 — 책 정보 검색

ISBN 이 있으면 ISBN 을, 없으면 `제목 + 저자 + 출판사` 를 질의로 쓴다(§5).

검색 경로는 두 갈래이고 결과를 병합한다.

1. **공개 서지 API** — 키가 필요 없는 Open Library / Google Books 로 ISBN → 정확한 서지정보.
   AI 오인식을 잡아내는 기준점 역할을 한다.
2. **OpenAI Responses API 의 내장 `web_search` 툴** — 줄거리·서평·독후감 등 문제 출제에 쓸 서술 정보.

수집 결과는 `book_sources` 에 `{source, url, title, content}` 로 저장한다.

> **저작권**: 책 원문을 수집·저장하지 않는다(§6). 공개된 소개글·줄거리 요약·서평만 발췌하며,
> 출처별 발췌는 2,000자 이하로 제한하고 URL 을 항상 함께 남긴다.

## 3단계 — Book Brief

2단계 결과를 하나의 프롬프트 컨텍스트로 정리한다. 별도 AI 호출 없이 서버에서 조립한다.

```
[책] 제목 / 저자 / 출판사 / 출간 / 대상 학년
[줄거리] ...
[등장인물] ...
[주요 사건] ...
[출처] url × N
```

**Brief 는 D1 에 저장해 재생성 때 재사용한다.** 문제를 다시 만들 때 1·2단계를 반복하지 않는다.

## 4단계 — 20문제 생성

시스템 프롬프트는 요구사항 §9 의 12개 조건을 그대로 사용한다.
추가로 서버가 강제하는 분배 규칙을 프롬프트에 넣는다.

- 유형 8종을 최소 2문항씩 배분 (8종 × 2 = 16, 나머지 4문항은 자유)
- 난이도 Easy 6 / Normal 8 / Hard 6
- 정답 위치 1~4번을 각 5문항씩

Structured Output 스키마 (§29):

```json
{
  "type": "object",
  "properties": {
    "questions": {
      "type": "array",
      "minItems": 20, "maxItems": 20,
      "items": {
        "type": "object",
        "properties": {
          "questionNumber": { "type": "integer" },
          "questionText":   { "type": "string" },
          "choices":        { "type": "array", "items": { "type": "string" }, "minItems": 4, "maxItems": 4 },
          "correctChoice":  { "type": "integer", "enum": [1, 2, 3, 4] },
          "questionType":   { "type": "string", "enum": ["EVENT","CHARACTER","DETAIL","SEQUENCE","CAUSE_EFFECT","ACTION","EMOTION","INFERENCE"] },
          "difficulty":     { "type": "integer", "enum": [1, 2, 3] },
          "explanation":    { "type": "string" },
          "evidence":       { "type": "string" },
          "readRequired":   { "type": "boolean" }
        },
        "required": ["questionNumber","questionText","choices","correctChoice","questionType","difficulty","explanation","evidence","readRequired"],
        "additionalProperties": false
      }
    }
  },
  "required": ["questions"],
  "additionalProperties": false
}
```

`strict: true` 로 호출한다. 자유 형식 텍스트 응답은 쓰지 않는다.

### 서버 측 사후 검사 (AI 호출 없음)

스키마가 못 잡는 것은 코드로 확인하고, 위반 문항은 5단계를 건너뛰고 바로 6단계 재생성 대상이 된다.

- 선택지 4개가 서로 다른가 (정규화 후 중복 검사)
- 정답 위치가 특정 번호에 6문항 이상 몰리지 않았는가 (§9-10)
- 문제 본문이 다른 문항과 유사하지 않은가 (토큰 자카드 유사도 0.7 이상이면 중복)
- 문제 본문에 책 제목/저자명이 그대로 들어가 있지 않은가 (§7 금지 유형 휴리스틱)

## 5단계 — AI 검증

20문항을 **한 번의 호출**로 검증한다. §10 의 10개 기준을 프롬프트로 전달하고 문항별 판정을 받는다.

```json
{
  "results": [
    { "questionNumber": 1, "valid": true, "score": 92, "reason": "", "readRequired": true }
  ]
}
```

`valid === false` 또는 `score < 70` 또는 `readRequired === false` 인 문항을 폐기 대상으로 본다.
판정은 `question_validations` 에 남긴다.

## 6단계 — 실패분만 재생성

재생성 요청에는 다음을 함께 준다.

- Book Brief (3단계 결과)
- **살아남은 문항들의 요약** — 중복 회피용
- 폐기된 문항과 폐기 사유 — 같은 실수 반복 방지
- 필요한 개수 N 과 채워야 할 유형/난이도

받은 문항을 원래 `questionNumber` 자리에 넣고 5단계로 돌아간다.

## 모델 선택

**모델 ID 를 코드에 고정하지 않는다.** OpenAI 라인업은 자주 바뀌고 계정마다 접근 가능한 모델도 다르다.
특정 이름을 상수로 박아 두면 그 모델이 사라지는 날 서비스가 멈춘다.

대신 `src/ai/models.ts` 는 **접두사 선호 목록**만 들고 있다.

```
PREFERENCE = ["gpt-5.6", "gpt-5.5", "gpt-5", "gpt-4.1", "gpt-4o"]
```

동작:

1. 부모의 키로 `GET /v1/models` 를 조회해 **그 계정이 실제로 쓸 수 있는 목록**을 얻는다
2. 쓸 수 없는 것을 이름으로 걸러낸다
3. 남은 것을 `세대 × 10 + 변종` 점수로 정렬한다 — 목록에 없는 접두사는 그냥 건너뛴다
4. 부모가 고르지 않았으면 맨 앞을 기본값으로 잡아 `parent_settings` 에 저장한다

### 걸러내는 것

| 대상 | 이유 |
| --- | --- |
| embedding · moderation · tts · transcribe · realtime · image · codex · computer-use | 문제 생성에 쓸 수 없는 계열 |
| `*-instruct` | 텍스트 완성 전용이라 채팅·구조화 출력을 못 쓴다 |
| `*-chat-latest` | 가리키는 실제 모델이 예고 없이 바뀐다. 재현 가능한 출제를 위해 제외 |
| `gpt-3.5-*` | 구조화 출력·긴 컨텍스트가 필요한 작업에 부적합 |
| `*-2026-04-23` 같은 날짜 스냅샷 | 기본 별칭과 중복이라 선택지만 늘린다 |

실제 계정에서 59개가 오던 목록이 25개로 줄어 부모가 고르기 쉬워진다.

### 정렬

같은 세대 안에서는 **기본 별칭 → mini/nano → 기타 → pro** 순이다.
`-pro` 는 가장 비싸므로 자동으로 선택되지 않게 뒤로 민다. 부모가 직접 고르는 것은 막지 않는다.

> 한 세대 안에 동급 변종이 여럿일 때(예: `gpt-5.6-luna` / `-sol` / `-terra`)는 우열을 판단할 근거가 없어
> 이름 길이·사전순으로 정한다. 사실상 임의 선택이므로 설정 화면에서 부모가 바꿀 수 있게 해 두었다.

부모가 직접 고를 때도 그 값이 계정 목록에 실제로 있는지 확인한 뒤에만 저장한다.
텍스트 생성용과 Vision 용을 따로 둔다 (`openai_model`, `openai_vision_model`).

선호 목록에 새 세대가 나오면 `FAMILY_PREFERENCE` 맨 앞에 문자열 하나만 추가하면 된다.
그 모델이 아직 없는 계정은 자동으로 다음 순위를 쓴다.

## 실패 처리

| 상황 | 처리 |
| --- | --- |
| 키 미설정 | `400 invalid` + 설정 화면으로 유도 |
| 키 무효 (401) | `400 invalid` + "API Key 를 다시 확인해 주세요" |
| 한도 초과 (429) | 지수 백오프 3회 재시도 후 `502 ai_failed` |
| 스키마 불일치 | 1회 재시도 후 실패 문항만 재생성 대상으로 |
| 3라운드 후 20개 미달 | 채운 만큼 REVIEW 로, `generation_error` 기록 |

모든 AI 호출은 소요 시간·토큰 수를 로그로 남긴다 (`observability.enabled = true`).
