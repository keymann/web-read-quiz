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
		found: { type: "boolean", description: "이 책을 특정할 수 있었는지." },
		title: { type: "string" },
		author: { type: "string" },
		publisher: { type: "string" },
		isbn13: { type: "string", description: "13자리 ISBN. 확인 못 했으면 빈 문자열." },
		publishedAt: { type: "string", description: "출간일 YYYY-MM-DD 또는 YYYY. 모르면 빈 문자열." },
		targetAge: { type: "string", description: "권장 독자 연령·학년. 모르면 빈 문자열." },
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
		"found",
		"title",
		"author",
		"publisher",
		"isbn13",
		"publishedAt",
		"targetAge",
		"description",
		"plotSummary",
		"characters",
		"keyEvents",
		"sources",
	],
	additionalProperties: false,
} as const;
