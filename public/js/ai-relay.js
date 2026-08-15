import { get, post } from "./api.js";

/**
 * 브라우저 릴레이 — 부모의 브라우저가 Gemini 를 직접 부른다.
 *
 * 왜: Cloudflare Worker 는 홍콩 콜로에서 나가는데 홍콩은 Gemini 미지원 지역이라 서버에서는
 * 호출이 막힌다. 부모의 브라우저는 지원 지역에 있으므로 여기서 부르면 통과한다.
 *
 * 이 파일이 하는 일은 **딱 두 가지**다.
 *   1. 서버가 만들어 준 요청을 그대로 Gemini 에 보낸다 (키만 붙여서)
 *   2. 받은 응답을 그대로 서버에 돌려준다
 *
 * 프롬프트도, 스키마도, 판정 기준도 여기 없다. 전부 서버에 있다.
 *
 * **키는 저장하지 않는다.** 작업이 시작될 때 받아 지역 변수로만 들고 있다가, 작업이 끝나면
 * 참조를 버린다. localStorage·sessionStorage·전역 변수 어디에도 남기지 않는다.
 */

/**
 * 이 브라우저가 AI 를 직접 불러야 하는지.
 *
 * 제공자가 gemini 일 때만이다. OpenAI·Vertex 는 서버에서 부를 수 있으므로 키를 내려보내지 않는다.
 * 캐시하지 않는다 — 부모가 설정에서 제공자를 바꾼 직후에도 바로 맞아야 한다.
 */
export async function usesBrowserRelay() {
	try {
		const view = await get("/api/settings");
		return view.provider === "gemini";
	} catch {
		return false;
	}
}

/** 한 번의 작업(분석·조사·생성) 동안만 키를 들고 있는 핸들. */
async function withCredential(run) {
	const credential = await get("/api/ai/credential");
	try {
		return await run(credential);
	} finally {
		// 참조를 끊는다. 이 함수를 벗어나면 키를 가리키는 변수가 남지 않는다.
		credential.apiKey = "";
	}
}

/** 서버가 만들어 준 요청을 Gemini 로 보낸다. 실패해도 키가 로그에 남지 않게 한다. */
async function callGemini(apiKey, plan) {
	let response;
	try {
		response = await fetch(plan.url, {
			method: "POST",
			headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
			body: JSON.stringify(plan.body),
		});
	} catch {
		throw new Error("Gemini 에 연결하지 못했습니다. 네트워크를 확인해 주세요.");
	}

	const payload = await response.json().catch(() => null);

	if (!response.ok) {
		const message = payload?.error?.message ?? `Gemini 호출 실패 (${response.status})`;
		const status = payload?.error?.status ?? "";
		// 그라운딩 권한이 없는 키인지 호출부가 판단할 수 있게 상태를 실어 준다.
		const error = new Error(message);
		error.status = response.status;
		error.googleStatus = status;
		throw error;
	}

	return payload;
}

/* ── 책 표지 식별 ─────────────────────────────────────── */

export async function identifyBook(bookId) {
	return withCredential(async ({ apiKey }) => {
		const plan = await post("/api/ai/plan", { kind: "identify", bookId });
		const response = await callGemini(apiKey, plan);
		return post("/api/ai/apply", { kind: "identify", bookId, response });
	});
}

/* ── 책 정보 조사 ─────────────────────────────────────── */

export async function researchBook(bookId) {
	return withCredential(async ({ apiKey }) => {
		// 먼저 웹 검색을 켜고 시도한다. 무료 등급 키는 그라운딩이 막혀 있어 429 가 온다.
		for (const webSearch of [true, false]) {
			const plan = await post("/api/ai/plan", { kind: "research", bookId, webSearch });
			try {
				const response = await callGemini(apiKey, plan);
				return await post("/api/ai/apply", {
					kind: "research",
					bookId,
					response,
					groundingUsed: webSearch,
				});
			} catch (err) {
				// 그라운딩 권한 문제일 때만 검색 없이 한 번 더. 그 외에는 그대로 알린다.
				const groundingBlocked = webSearch && err.status === 429;
				if (!groundingBlocked) throw err;
			}
		}
		throw new Error("책 정보를 정리하지 못했습니다.");
	});
}

/* ── 문제 생성 ───────────────────────────────────────── */

/** 서버가 라운드를 이끈다. 브라우저는 시키는 호출만 한다. 최대 라운드도 서버 목표치로 정해진다. */
const MAX_ROUNDS = 3;

export async function generateQuestions(quizId, onProgress) {
	return withCredential(async ({ apiKey }) => {
		let rejected = [];
		let last = null;

		for (let round = 1; round <= MAX_ROUNDS; round++) {
			// 1) 이번 라운드에 몇 개가 더 필요한지 서버가 정한다
			const plan = await post("/api/ai/plan", { kind: "generate", quizId, rejected });
			if (plan.done) return { accepted: plan.accepted, target: plan.target, done: true };

			onProgress?.({ accepted: plan.accepted, target: plan.target, phase: "generating" });

			// 2) 문제를 만든다
			const generated = await callGemini(apiKey, plan);

			// 3) 서버가 사후검사를 돌리고 검증 요청을 만들어 준다
			const validatePlan = await post("/api/ai/plan", {
				kind: "validate",
				quizId,
				response: generated,
			});
			rejected = [...rejected, ...validatePlan.rejected].slice(-20);

			// 사후검사에서 전멸했으면 검증할 게 없다. 다음 라운드로.
			if (validatePlan.questions.length === 0) continue;

			onProgress?.({ accepted: last?.accepted ?? 0, target: validatePlan.target, phase: "validating" });

			// 4) 검수한다
			const verdicts = await callGemini(apiKey, validatePlan);

			// 5) 서버가 임계값을 적용하고 통과분만 저장한다
			last = await post("/api/ai/apply", {
				kind: "accept",
				quizId,
				questions: validatePlan.questions,
				response: verdicts,
			});
			rejected = [...rejected, ...last.rejected].slice(-20);

			onProgress?.({ accepted: last.accepted, target: last.target, phase: "generating" });
			if (last.done) return last;
		}

		return last ?? { accepted: 0, target: 0, done: false };
	});
}
