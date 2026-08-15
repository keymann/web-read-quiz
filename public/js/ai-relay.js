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

/**
 * 잠깐 기다리면 풀리는 상태들 — 서버가 과부하일 때다. 몇 초 뒤 같은 모델로 다시 부른다.
 */
const RETRYABLE = new Set([500, 502, 503, 504]);

/**
 * 이 모델의 한도를 다 썼다는 뜻(`RESOURCE_EXHAUSTED`). 몇 초 기다린다고 풀리지 않으므로
 * 같은 모델로 다시 부르지 않고 바로 다른 모델로 넘어간다.
 *
 * 실측: 무료 등급 키에서 최신 flash 모델은 거의 항상 429 다. 재시도를 3번 돌면 매 단계마다
 * 4.5초를 그냥 버리게 된다.
 */
const QUOTA_EXHAUSTED = 429;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * 한 단계를 끝까지 밀어붙인다 — 계획 받기 → 호출 → (필요하면) 재시도 → 모델 교체.
 *
 * Gemini 는 인기 모델이 자주 `503 UNAVAILABLE` 을 낸다(실측). 서버 호출 경로에는 재시도와
 * 모델 폴백이 있는데 릴레이 경로에만 없으면, 같은 상황에서 부모에게 그냥 실패로 보인다.
 *
 * **브라우저는 모델을 고르지 않는다.** "이 모델은 응답하지 않더라" 만 `avoid` 로 알려주고,
 * 다음에 무엇을 쓸지는 서버가 정한다. 후보가 떨어지면 서버가 거절한다.
 *
 * `fatal` 은 재시도해도 소용없는 실패를 가려낸다(예: 웹 검색 권한이 없는 키의 429).
 * `onPlan` 은 긴 호출을 보내기 직전에, `onNote` 는 재시도·모델 교체 때 불린다 — 둘 다
 * 화면이 "지금 무엇을 하고 있는지" 를 계속 보여줄 수 있게 하기 위한 것이다.
 */
async function runStep(apiKey, request, { fatal, onNote, onPlan } = {}) {
	const avoid = [];

	for (;;) {
		const plan = await post("/api/ai/plan", { ...request, avoid });
		// 서버가 "더 할 일 없음" 이라고 하면 호출할 것도 없다.
		if (plan.done || plan.url === undefined) return { plan, response: null };

		// 호출을 보내기 **전에** 알린다. 응답을 기다리는 수십 초 동안 화면이 멈춰 보이면 안 된다.
		onPlan?.(plan);

		let lastError;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				return { plan, response: await callGemini(apiKey, plan) };
			} catch (err) {
				if (fatal?.(err)) throw err;
				lastError = err;
				if (err.status === QUOTA_EXHAUSTED) break; // 기다려도 안 풀린다. 모델을 바꾼다.
				if (!RETRYABLE.has(err.status)) throw err;
				if (attempt < 3) {
					onNote?.(`AI 가 지금 붐벼서 잠시 뒤 다시 시도합니다 (${attempt}/3)`);
					await wait(attempt * 1500);
				}
			}
		}

		// 재시도로 안 풀렸다. 이 모델은 빼고 서버에게 다시 물어본다.
		avoid.push(plan.model);
		if (avoid.length >= 3) throw lastError;
		onNote?.(`${plan.model} 모델이 응답하지 않아 다른 모델로 바꿉니다`);
	}
}

/* ── 키 등록 ─────────────────────────────────────────── */

/** Gemini 모델 목록 조회 엔드포인트. 서버가 부를 수 없으므로 브라우저가 직접 부른다. */
const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200";

/**
 * 아직 저장 전인 키로 모델 목록을 조회한다.
 *
 * 서버는 Gemini 를 부를 수 없으므로 키가 유효한지 확인할 방법이 없다. 이 조회가 성공했다는
 * 것 자체가 키가 유효하다는 증거이고, 받은 목록을 저장 요청에 함께 실어 보낸다.
 *
 * 여기서는 **거르지 않는다.** 무엇을 쓸 수 있고 무엇이 먼저인지는 서버가 정한다(단일 기준).
 * 목록을 누가 가져왔는지와 무관하게 같은 규칙이 적용되어야 한다.
 */
export async function fetchGeminiModels(apiKey) {
	let response;
	try {
		response = await fetch(GEMINI_MODELS_URL, { headers: { "x-goog-api-key": apiKey } });
	} catch {
		throw new Error("Gemini 에 연결하지 못했습니다. 네트워크를 확인해 주세요.");
	}

	const payload = await response.json().catch(() => null);
	if (!response.ok) {
		throw new Error(payload?.error?.message ?? `Gemini 키를 확인하지 못했습니다 (${response.status})`);
	}

	return (payload.models ?? [])
		.filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
		.map((m) => (m.name ?? "").replace(/^models\//, ""))
		.filter(Boolean);
}

/* ── 책 표지 식별 ─────────────────────────────────────── */

export async function identifyBook(bookId) {
	return withCredential(async ({ apiKey }) => {
		const { plan, response } = await runStep(apiKey, { kind: "identify", bookId });
		const result = await post("/api/ai/apply", { kind: "identify", bookId, response });
		return { ...result, modelNotice: plan.modelNotice ?? result.modelNotice ?? null };
	});
}

/* ── 책 정보 조사 ─────────────────────────────────────── */

export async function researchBook(bookId) {
	return withCredential(async ({ apiKey }) => {
		// 먼저 웹 검색을 켜고 시도한다. 무료 등급 키는 그라운딩이 막혀 있어 429 가 온다.
		for (const webSearch of [true, false]) {
			try {
				const { plan, response } = await runStep(
					apiKey,
					{ kind: "research", bookId, webSearch },
					// 검색을 켠 상태의 429 는 계정 등급 문제다. 재시도도 모델 교체도 소용없다.
					{ fatal: (err) => webSearch && err.status === 429 },
				);
				const result = await post("/api/ai/apply", {
					kind: "research",
					bookId,
					response,
					groundingUsed: webSearch,
				});
				return { ...result, modelNotice: plan.modelNotice ?? result.modelNotice ?? null };
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

/**
 * 문제를 만든다. 진행 상황을 **호출 전에** 알린다.
 *
 * 생성 한 번이 30초를 넘기는 일이 흔하다. 끝난 뒤에만 알리면 그 시간 내내 화면이 멈춰
 * 보이고, 부모는 고장 났다고 생각해 새로고침한다(그러면 정말로 중단된다). 그래서 무엇을
 * 하려는 참인지를 먼저 알리고, 기다리는 동안에도 무슨 일이 벌어지는지 계속 보이게 한다.
 */
export async function generateQuestions(quizId, onProgress) {
	return withCredential(async ({ apiKey }) => {
		let rejected = [];
		let last = null;
		/** 마지막으로 알린 상태. 곁가지 소식(재시도 등)이 숫자를 지우지 않게 들고 있는다. */
		let state = { accepted: 0, target: 0 };

		const report = (patch) => {
			state = { ...state, note: null, ...patch };
			onProgress?.(state);
		};

		for (let round = 1; round <= MAX_ROUNDS; round++) {
			report({ phase: "planning", round });

			// 1) 이번 라운드에 몇 개가 더 필요한지 서버가 정하고, 브라우저가 그 요청을 보낸다.
			//    onPlan 은 **긴 호출 직전**에 불린다 — 기다림이 시작되기 전에 알려야 의미가 있다.
			const { plan, response: generated } = await runStep(
				apiKey,
				{ kind: "generate", quizId, rejected },
				{
					onPlan: (p) =>
						report({ phase: "generating", round, need: p.need, accepted: p.accepted, target: p.target }),
					onNote: (note) => report({ note }),
				},
			);
			if (plan.done) return { accepted: plan.accepted, target: plan.target, done: true };

			// 2) 만든 문제를 서버가 사후검사하고, 남은 것만 AI 검수로 보낸다
			report({ phase: "screening", round, accepted: plan.accepted, target: plan.target });

			const { plan: validatePlan, response: verdicts } = await runStep(
				apiKey,
				{ kind: "validate", quizId, response: generated },
				{
					onPlan: (p) => report({ phase: "validating", round, checking: p.questions?.length ?? 0 }),
					onNote: (note) => report({ note }),
				},
			);
			rejected = [...rejected, ...validatePlan.rejected].slice(-20);

			// 사후검사에서 전멸했으면 검증할 게 없다. 다음 라운드로.
			if (validatePlan.questions.length === 0) {
				report({ phase: "retrying", round, dropped: validatePlan.rejected.length });
				continue;
			}

			// 3) 서버가 임계값을 적용하고 통과분만 저장한다
			report({ phase: "saving", round });

			last = await post("/api/ai/apply", {
				kind: "accept",
				quizId,
				questions: validatePlan.questions,
				response: verdicts,
			});
			rejected = [...rejected, ...last.rejected].slice(-20);

			report({
				phase: last.done ? "done" : "retrying",
				round,
				dropped: last.rejected.length,
				accepted: last.accepted,
				target: last.target,
			});
			if (last.done) return last;
		}

		return last ?? { accepted: 0, target: 0, done: false };
	});
}
