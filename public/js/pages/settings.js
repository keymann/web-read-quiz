import { del, get, put } from "../api.js";
import { requireSession } from "../session.js";
import { banner, confirmAction, el, field, header, mount, selectField, setKidMode } from "../ui.js";

/**
 * 부모 설정 — OpenAI API Key 등록과 모델 선택(§25).
 *
 * 키는 입력만 하고 다시 읽어오지 않는다. 서버는 등록 여부와 마지막 4자리만 돌려준다.
 */
export async function settingsPage() {
	setKidMode(false);
	const s = await requireSession("PARENT");
	if (!s) return;

	let message = null;
	let messageKind = "error";
	let models = [];

	await refresh();

	async function refresh() {
		let view = { openai: { configured: false, last4: null, model: null, visionModel: null } };
		try {
			view = await get("/api/settings");
			if (view.openai.configured && models.length === 0) {
				({ models } = await get("/api/settings/openai/models"));
			}
		} catch (err) {
			message = err.message;
			messageKind = "error";
		}
		render(view);
	}

	function render(view) {
		mount(
			header("설정", [el("a", { class: "btn btn--ghost", href: "/parent", "data-link": true, text: "← 홈" })]),
			message ? banner(message, messageKind) : null,
			keyCard(view),
			view.openai.configured && models.length > 0 ? modelCard(view) : null,
			guideCard(),
		);
	}

	function keyCard(view) {
		const apiKey = field("OpenAI API Key", {
			type: "password",
			autocomplete: "off",
			placeholder: "sk-...",
			required: true,
		});

		const status = view.openai.configured
			? el("p", { class: "status status--ok" }, [
					el("strong", { text: "등록됨" }),
					` · 끝 4자리 ${view.openai.last4}`,
				])
			: el("p", { class: "status status--warn", text: "아직 등록되지 않았습니다." });

		const form = el("form", { class: "card" }, [
			el("h2", { class: "section-title", text: "OpenAI API Key" }),
			status,
			el("p", {
				class: "hint",
				text: "키는 서버에서 암호화해 보관하며, 저장 후에는 다시 보여드리지 않습니다. AI 호출은 모두 서버에서만 일어납니다.",
			}),
			apiKey.wrap,
			el("div", { class: "row" }, [
				el("button", { class: "btn", type: "submit", text: view.openai.configured ? "키 교체" : "저장" }),
				view.openai.configured
					? el("button", {
							class: "btn btn--danger",
							type: "button",
							text: "삭제",
							onClick: async () => {
								if (!confirmAction("등록된 API Key 를 삭제할까요?\n삭제하면 문제를 생성할 수 없습니다.")) return;
								try {
									await del("/api/settings/openai-key");
									models = [];
									message = "API Key 를 삭제했습니다.";
									messageKind = "info";
								} catch (err) {
									message = err.message;
									messageKind = "error";
								}
								await refresh();
							},
						})
					: null,
			]),
		]);

		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			const button = form.querySelector("button[type=submit]");
			button.disabled = true;
			try {
				const result = await put("/api/settings/openai-key", { apiKey: apiKey.input.value });
				models = result.models;
				message = "API Key 를 확인하고 저장했습니다.";
				messageKind = "info";
			} catch (err) {
				message = err.message;
				messageKind = "error";
			}
			await refresh();
		});

		return form;
	}

	function modelCard(view) {
		const model = selectField("문제 생성 모델", models, view.openai.model);
		const visionModel = selectField("책 표지 인식 모델", models, view.openai.visionModel);

		const form = el("form", { class: "card" }, [
			el("h2", { class: "section-title", text: "모델" }),
			el("p", {
				class: "hint",
				text: "이 계정에서 쓸 수 있는 모델만 보입니다. 잘 모르겠다면 맨 위 값을 그대로 두세요.",
			}),
			model.wrap,
			visionModel.wrap,
			el("button", { class: "btn", type: "submit", text: "모델 저장" }),
		]);

		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			try {
				await put("/api/settings/openai/models", {
					model: model.select.value,
					visionModel: visionModel.select.value,
				});
				message = "모델을 저장했습니다.";
				messageKind = "info";
			} catch (err) {
				message = err.message;
				messageKind = "error";
			}
			await refresh();
		});

		return form;
	}

	/** §25 — API Key 를 어디서 어떻게 받는지 안내. */
	function guideCard() {
		const steps = [
			"OpenAI 플랫폼(platform.openai.com)에 로그인합니다.",
			"오른쪽 위 프로필 → API keys 로 들어갑니다.",
			"Create new secret key 를 눌러 키를 만듭니다. 이름은 아무거나 좋습니다.",
			"sk- 로 시작하는 키가 화면에 한 번만 보입니다. 이때 복사해서 위에 붙여넣으세요.",
			"Billing 메뉴에서 결제 수단을 등록해야 실제로 호출이 됩니다. 무료 크레딧만으로는 실패할 수 있습니다.",
		];

		return el("section", { class: "card card--muted" }, [
			el("h2", { class: "section-title", text: "API Key 발급 방법" }),
			el("ol", { class: "steps" }, steps.map((text) => el("li", { text }))),
			el("p", {
				class: "hint",
				text: "키는 비밀번호와 같습니다. 다른 사람에게 공유하지 마시고, 유출된 것 같으면 OpenAI 에서 즉시 폐기(Revoke)한 뒤 새 키를 등록해 주세요.",
			}),
			el("p", { class: "hint", text: "문제 20개를 만드는 데 OpenAI 호출이 보통 4번 일어납니다. 비용은 사용하신 키로 청구됩니다." }),
		]);
	}
}
