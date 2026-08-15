import { put } from "../api.js";
import { el, field } from "../ui.js";

/**
 * 출제 설정 탭 — 한 번에 낼 문제 개수와 통과 개수(§17·§21.1).
 *
 * 여기서 바꾼 값은 **앞으로 만드는 퀴즈**에만 적용된다. 이미 만들어진 퀴즈는 만들 때의
 * 기준을 그대로 들고 있어, 아이가 이미 푼 결과의 합격 여부가 나중에 뒤바뀌지 않는다.
 */
export function quizSettingsCard(view, { onMessage }) {
	const { questionCount, passCount, minQuestions, maxQuestions } = view.quiz;

	const count = field(`한 번에 낼 문제 개수 (${minQuestions}~${maxQuestions})`, {
		type: "number",
		min: String(minQuestions),
		max: String(maxQuestions),
		value: questionCount,
		required: true,
	});
	const pass = field("통과 개수 (몇 개를 맞히면 통과)", {
		type: "number",
		min: "1",
		max: String(maxQuestions),
		value: passCount,
		required: true,
	});

	const summary = el("p", { class: "status status--ok" });
	const updateSummary = () => {
		const c = Number(count.input.value);
		const p = Number(pass.input.value);
		summary.textContent =
			Number.isFinite(c) && Number.isFinite(p) && p >= 1 && p <= c
				? `${c}문제 중 ${p}개를 맞히면 통과합니다. 점수는 통과 기준을 100점으로 환산해 매깁니다.`
				: "통과 개수는 1 이상, 문제 개수 이하로 정해 주세요.";
		summary.className = p >= 1 && p <= c ? "status status--ok" : "status status--warn";
	};
	updateSummary();
	count.input.addEventListener("input", updateSummary);
	pass.input.addEventListener("input", updateSummary);

	const form = el("form", { class: "card" }, [
		el("h2", { class: "section-title", text: "출제 설정" }),
		el("p", {
			class: "hint",
			text: "아이의 학년이나 책 분량에 맞춰 조절하세요. 기본값은 20문제 중 10개 통과입니다.",
		}),
		count.wrap,
		pass.wrap,
		summary,
		el("p", {
			class: "hint",
			text: "여기서 바꾼 값은 앞으로 만드는 퀴즈에만 적용됩니다. 이미 만든 퀴즈의 기준은 그대로 유지되어, 아이가 이미 푼 결과의 합격 여부가 뒤바뀌지 않습니다.",
		}),
		el("button", { class: "btn", type: "submit", text: "저장" }),
	]);

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		try {
			await put("/api/settings/quiz", {
				questionCount: Number(count.input.value),
				passCount: Number(pass.input.value),
			});
			onMessage("출제 설정을 저장했습니다.", "info");
		} catch (err) {
			onMessage(err.message, "error");
		}
	});

	return form;
}
