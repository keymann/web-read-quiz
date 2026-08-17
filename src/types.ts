/**
 * 서비스 전역에서 공유하는 도메인 타입.
 *
 * `Env` 는 `npm run cf-typegen` 이 wrangler.jsonc 로부터 생성한다(바인딩만 포함).
 * Secret 은 wrangler.jsonc 에 적지 않으므로 여기서 따로 선언해 `AppEnv` 로 합친다.
 */

export interface AppEnv extends Env {
	/** 세션 토큰 서명 키. `wrangler secret put SESSION_SECRET` */
	SESSION_SECRET: string;
	/** 부모의 OPENAI_API_KEY 를 암호화할 AES-GCM 마스터 키(base64 32바이트). */
	ENCRYPTION_KEY: string;
	/** 설정 시 회원가입에 초대 코드를 요구한다. 비어 있으면 제한 없음. */
	INVITE_CODE?: string;
	/**
	 * 국내 서지 조회용 키. **부모별이 아니라 서비스 공용**이다.
	 *
	 * AI 키를 부모마다 받는 이유는 비용이 부모에게 청구되기 때문인데(§25), 이쪽은 무료다.
	 * 알라딘은 발급에 승인 1~2일이 걸려 부모에게 요구할 수도 없다.
	 * 없으면 그 소스를 조용히 건너뛴다 — 서지 조회가 실패해도 파이프라인은 멈추지 않는다.
	 */
	ALADIN_TTB_KEY?: string;
	KAKAO_REST_KEY?: string;
}

export type Role = "PARENT" | "CHILD";

export type QuizStatus =
	| "DRAFT"
	| "GENERATING"
	| "REVIEW"
	| "APPROVED"
	| "ASSIGNED"
	| "IN_PROGRESS"
	| "COMPLETED";

export type AssignmentStatus = "ASSIGNED" | "IN_PROGRESS" | "COMPLETED";

export type QuestionType =
	| "EVENT"
	| "CHARACTER"
	| "DETAIL"
	| "SEQUENCE"
	| "CAUSE_EFFECT"
	| "ACTION"
	| "EMOTION"
	| "INFERENCE";

/** 1 = Easy, 2 = Normal, 3 = Hard */
export type Difficulty = 1 | 2 | 3;

export type ChoiceNumber = 1 | 2 | 3 | 4;

export type QuestionHistoryAction =
	| "AI_GENERATED"
	| "AI_REGENERATED"
	| "PARENT_EDITED"
	| "PARENT_DELETED"
	| "PARENT_APPROVED";

/** 로그인 세션에서 복원한 신원. 클라이언트가 보낸 id 는 절대 신뢰하지 않는다(§26). */
export interface Principal {
	userId: string;
	role: Role;
	displayName: string;
	/** role === "CHILD" 인 경우에만 채워진다. */
	childId?: string;
}

/** 모든 API 응답은 이 형태를 유지한다(§31.14). */
export type ApiResponse<T> =
	| { ok: true; data: T }
	| { ok: false; error: { code: string; message: string } };

/* ── D1 행 타입 ─────────────────────────────────────────── */

export interface UserRow {
	id: string;
	login_id: string;
	password_hash: string;
	role: Role;
	display_name: string;
	is_active: number;
	created_at: string;
	updated_at: string;
}

export interface ChildRow {
	id: string;
	parent_user_id: string;
	child_user_id: string | null;
	name: string;
	grade: number | null;
	is_active: number;
	created_at: string;
	updated_at: string;
}

/** 클라이언트로 내보내는 아이 정보. 내부 user id 는 노출하지 않는다. */
export interface ChildView {
	id: string;
	name: string;
	grade: number | null;
	loginId: string | null;
	createdAt: string;
}

/** 문제를 낼 언어. 책이 한국어여도 문제는 영어로 낼 수 있다(영어 독해 겸용). */
export type QuestionLanguage = "en" | "ko";
