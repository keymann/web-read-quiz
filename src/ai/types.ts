import type { ApiError } from "../utils/response";

/**
 * AI 제공자 추상화.
 *
 * 부모마다 이미 가진 키가 다르다. Gemini 는 결제 수단 없이도 이미지 입력 · 구조화 출력 ·
 * 웹 검색을 무료 티어에서 쓸 수 있어 진입 장벽이 낮고, OpenAI 는 상위 모델을 쓸 수 있다.
 * 어느 쪽을 쓰든 상위 레이어(services · routes · 화면)는 이 인터페이스만 본다.
 */

export type ProviderName = "openai" | "gemini" | "vertex";

export const PROVIDER_NAMES: ProviderName[] = ["openai", "gemini", "vertex"];

export const isProviderName = (value: string): value is ProviderName =>
	(PROVIDER_NAMES as string[]).includes(value);

export interface StructuredRequest {
	model: string;
	/** 시스템 지시. 역할과 규칙을 넣는다. */
	instructions?: string;
	/** 사용자 프롬프트. */
	prompt: string;
	/** 있으면 이미지 입력으로 함께 보낸다(표지 인식). */
	image?: { bytes: Uint8Array; mime: string };
	/** 제공자 내장 웹 검색 툴을 켠다. */
	webSearch?: boolean;
	/** 스키마 이름은 모델에게 의미 힌트가 된다. 영문 소문자·밑줄. */
	schemaName: string;
	/** JSON Schema. 제공자별 방언 변환은 각 구현이 알아서 한다. */
	schema: Record<string, unknown>;
}

export interface CallOptions {
	timeoutMs?: number;
	/** 429·5xx 재시도 횟수. 멱등하지 않거나 비싼 호출은 1 로 둔다. */
	maxAttempts?: number;
}

export interface AiProvider {
	readonly name: ProviderName;
	/** 화면에 보여줄 이름. */
	readonly label: string;
	/** 키 발급 페이지. 설정 화면 안내에 쓴다. */
	readonly consoleUrl: string;

	/** 키 형식이 이 제공자의 것으로 보이는지. 아니면 ApiError 를 던진다. */
	assertKeyFormat(apiKey: string): void;

	/**
	 * 설정 화면에 보여줄 짧은 식별자. 키 원문을 노출하지 않으면서 "어떤 걸 등록했는지" 알려준다.
	 * API Key 는 끝 4자리, 서비스 계정은 프로젝트 이름처럼 제공자마다 다르다.
	 */
	keyLabel(apiKey: string): string;

	/** 이 계정에서 문제 생성에 쓸 만한 모델 id. 선호 순서로 정렬해서 돌려준다. */
	listModels(apiKey: string): Promise<string[]>;

	/**
	 * 실제 추론이 되는지 확인한다. 문제 없으면 null, 아니면 사용자에게 보여줄 안내 문구.
	 * 목록 조회는 인증만 검증하므로 이 확인이 따로 필요하다.
	 */
	probe(apiKey: string, model: string): Promise<string | null>;

	/** 구조화 출력 호출. 파싱까지 끝난 객체를 돌려준다. */
	structured<T>(apiKey: string, request: StructuredRequest, options?: CallOptions): Promise<T>;
}

/** HTTP 응답을 사용자에게 보여줄 에러와 재시도 여부로 분류한다. 제공자마다 다르다. */
export type Classify = (status: number, body: unknown) => { error: ApiError; retryable: boolean };
