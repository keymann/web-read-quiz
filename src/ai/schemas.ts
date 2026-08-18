/**
 * OpenAI Structured Output 용 JSON Schema 모음(§29).
 *
 * `strict: true` 로 쓰기 때문에 지켜야 할 제약이 있다.
 *  - 모든 property 가 `required` 에 들어가야 한다 (선택 항목은 빈 문자열/빈 배열로 받는다)
 *  - 모든 object 에 `additionalProperties: false`
 */

export const BOOK_IDENTITY_SCHEMA = {
	type: "object",
	properties: {
		title: { type: "string", description: "표지에 적힌 책 제목. 읽을 수 없으면 빈 문자열." },
		author: { type: "string", description: "지은이. 옮긴이·그림 작가와 구분할 것." },
		publisher: { type: "string", description: "출판사." },
		isbn: { type: "string", description: "표지나 바코드에서 읽은 ISBN. 숫자만. 없으면 빈 문자열." },
		series: { type: "string", description: "시리즈명이 따로 있으면. 없으면 빈 문자열." },
		confidence: { type: "number", description: "0~1. 표지를 얼마나 확실히 읽었는지." },
	},
	required: ["title", "author", "publisher", "isbn", "series", "confidence"],
	additionalProperties: false,
} as const;

export const BOOK_RESEARCH_SCHEMA = {
	type: "object",
	properties: {
		// `found` 는 모델에게 묻지 않는다. 스키마 첫 필드로 두면 모델이 내용을 떠올리기 전에
		// 판단을 확정해 버려, 아는 책인데도 false 로 빠지는 일이 생긴다(실측 확인).
		// 서버가 채워진 내용을 보고 도출한다.
		title: { type: "string" },
		author: { type: "string" },
		publisher: { type: "string" },
		isbn13: { type: "string", description: "13자리 ISBN. 확인 못 했으면 빈 문자열." },
		publishedAt: { type: "string", description: "출간일 YYYY-MM-DD 또는 YYYY. 모르면 빈 문자열." },
		targetAge: { type: "string", description: "권장 독자 연령·학년. 모르면 빈 문자열." },
		bookLanguage: {
			type: "string",
			description: "이 책이 쓰인 언어의 ISO 639-1 두 글자(영어 en, 한국어 ko). 모르면 빈 문자열.",
		},
		/*
		 * 아래 넷은 영문책에만 있는 척도다. 한국어 책이면 전부 빈 문자열이어야 한다.
		 *
		 * **여기서는 짐작을 받는다.** 서버가 먼저 전용 검색으로 실제 페이지에서 찾아보고,
		 * 거기서 못 찾았을 때만 이 값을 쓴다. 그 경우 화면에 "AI가 추측한 등급" 이라고
		 * 분명히 적어 내보내므로, 부모가 확인된 값으로 오해하지 않는다.
		 */
		arLevel: {
			type: "string",
			description:
				"Accelerated Reader 의 ATOS 북 레벨(예: 4.7). 아는 값이 있으면 그것을, 없으면 책의 어휘·문장 길이·분량으로 미루어 짐작한 값을 적으세요. 짐작할 근거도 없으면 빈 문자열.",
		},
		arPoints: {
			type: "string",
			description: "AR 포인트(예: 5.0). 분량에 비례합니다. 모르면 짐작해도 됩니다. 근거가 없으면 빈 문자열.",
		},
		arInterestLevel: {
			type: "string",
			description: "AR 흥미 수준. LG(K-3) · MG(4-8) · MG+(6-8) · UG(9-12) 중 하나. 모르면 빈 문자열.",
		},
		lexile: {
			type: "string",
			description:
				"렉사일 지수를 접두어까지 그대로(예: 620L, AD540L). 아는 값이 없으면 짐작한 값을 적으세요. 근거가 없으면 빈 문자열.",
		},
		description: { type: "string", description: "책 소개 2~4문장." },
		plotSummary: { type: "string", description: "줄거리 요약. 결말을 포함해 최대한 구체적으로." },
		characters: {
			type: "array",
			description: "주요 등장인물.",
			items: {
				type: "object",
				properties: {
					name: { type: "string" },
					role: { type: "string", description: "이 인물이 이야기에서 하는 역할·성격." },
				},
				required: ["name", "role"],
				additionalProperties: false,
			},
		},
		keyEvents: {
			type: "array",
			description: "이야기의 주요 사건을 일어난 순서대로.",
			items: { type: "string" },
		},
		sources: {
			type: "array",
			description: "위 내용의 근거가 된 공개 웹 페이지.",
			items: {
				type: "object",
				properties: {
					url: { type: "string" },
					title: { type: "string" },
					content: { type: "string", description: "해당 페이지에서 인용한 요약 발췌." },
				},
				required: ["url", "title", "content"],
				additionalProperties: false,
			},
		},
	},
	required: [
		"title",
		"author",
		"publisher",
		"isbn13",
		"publishedAt",
		"targetAge",
		"bookLanguage",
		"arLevel",
		"arPoints",
		"arInterestLevel",
		"lexile",
		"description",
		"plotSummary",
		"characters",
		"keyEvents",
		"sources",
	],
	additionalProperties: false,
} as const;

/** 문제 유형(§8). 프롬프트와 DB CHECK 제약이 같은 값을 쓴다. */
export const QUESTION_TYPES = [
	"EVENT",
	"CHARACTER",
	"DETAIL",
	"SEQUENCE",
	"CAUSE_EFFECT",
	"ACTION",
	"EMOTION",
	"INFERENCE",
] as const;

const QUESTION_ITEM_SCHEMA = {
	type: "object",
	properties: {
		questionNumber: { type: "integer", description: "1부터 시작하는 문제 번호." },
		questionText: { type: "string", description: "문제 본문. 초등 고학년이 읽을 수 있는 문장." },
		choices: {
			type: "array",
			description: "선택지 4개. 서로 뚜렷하게 달라야 한다.",
			items: { type: "string" },
		},
		correctChoice: { type: "integer", description: "정답 선택지 번호 1~4." },
		questionType: { type: "string", enum: QUESTION_TYPES },
		difficulty: { type: "integer", description: "1=Easy, 2=Normal, 3=Hard." },
		explanation: { type: "string", description: "왜 그 선택지가 정답인지 아이에게 설명하는 문장." },
		evidence: { type: "string", description: "이 문제의 근거가 된 책 속 내용." },
		readRequired: { type: "boolean", description: "책을 읽어야만 풀 수 있는 문제인지." },
	},
	required: [
		"questionNumber",
		"questionText",
		"choices",
		"correctChoice",
		"questionType",
		"difficulty",
		"explanation",
		"evidence",
		"readRequired",
	],
	additionalProperties: false,
} as const;

export const QUESTIONS_SCHEMA = {
	type: "object",
	properties: {
		questions: { type: "array", items: QUESTION_ITEM_SCHEMA },
	},
	required: ["questions"],
	additionalProperties: false,
} as const;

/** 문제 검증 결과(§10). 문항별로 하나씩. */
export const VALIDATION_SCHEMA = {
	type: "object",
	properties: {
		results: {
			type: "array",
			items: {
				type: "object",
				properties: {
					questionNumber: { type: "integer" },
					valid: { type: "boolean", description: "10가지 기준을 모두 통과했는지." },
					score: { type: "integer", description: "0~100. 독서 확인 문제로서의 품질." },
					reason: { type: "string", description: "문제가 있다면 무엇이 문제인지. 없으면 빈 문자열." },
					readRequired: { type: "boolean", description: "책을 읽어야만 풀 수 있는지." },
				},
				required: ["questionNumber", "valid", "score", "reason", "readRequired"],
				additionalProperties: false,
			},
		},
	},
	required: ["results"],
	additionalProperties: false,
} as const;
