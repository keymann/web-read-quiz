import { del, get, put } from "../api.js";
import { requireSession } from "../session.js";
import { banner, confirmAction, el, field, header, mount, selectField, setKidMode } from "../ui.js";

/**
 * 부모 설정 — AI 제공자 선택과 API Key 등록(§25).
 *
 * 키는 입력만 하고 다시 읽어오지 않는다. 서버는 등록 여부와 마지막 4자리만 돌려준다.
 */

/** 제공자별 키 발급 안내. 부모가 이 화면을 보면서 그대로 따라갈 수 있어야 한다. */
const GUIDES = {
	openai: {
		title: "OpenAI API Key 발급 방법",
		steps: [
			"platform.openai.com 에 로그인합니다.",
			"오른쪽 위 프로필 → API keys 로 들어갑니다.",
			"Create new secret key 를 눌러 키를 만듭니다. 이름은 아무거나 좋습니다.",
			"sk- 로 시작하는 키가 화면에 한 번만 보입니다. 이때 복사해서 위에 붙여넣으세요.",
			"Billing 메뉴에서 결제 수단을 등록해야 실제로 호출이 됩니다. 등록하지 않으면 키가 유효해도 문제 생성이 막힙니다.",
		],
		note: "결제 수단 등록이 반드시 필요합니다. 사용한 만큼 청구됩니다.",
	},
	gemini: {
		title: "Gemini API Key 발급 방법",
		steps: [
			"aistudio.google.com/apikey 에 Google 계정으로 로그인합니다.",
			"‘API 키 만들기’(Create API key) 를 누릅니다.",
			"기존 Google Cloud 프로젝트를 고르거나 새 프로젝트를 만듭니다.",
			"AIza 로 시작하는 키를 복사해서 위에 붙여넣으세요.",
			"결제 수단을 등록하지 않아도 무료 등급으로 바로 쓸 수 있습니다.",
		],
		note: "무료 등급에서는 입력한 내용이 Google 제품 개선에 사용될 수 있고, Flash 계열 모델만 쓸 수 있습니다. 이것이 신경 쓰이면 Google Cloud 에서 결제 계정을 연결하세요.",
	},
};

export async function settingsPage() {
	setKidMode(false);
	const s = await requireSession("PARENT");
	if (!s) return;

	let message = null;
	let messageKind = "error";
	let models = [];
	/** 화면에서 고르고 있는 제공자. 저장 전까지는 서버 값과 다를 수 있다. */
	let draftProvider = null;

	await refresh();

	async function refresh() {
		let view = null;
		try {
			view = await get("/api/settings");
			if (draftProvider === null) draftProvider = view.provider;
			// 제공자를 바꾸는 중이면 이전 제공자의 모델 목록은 의미가 없다.
			if (view.ai.configured && draftProvider === view.provider && models.length === 0) {
				({ models } = await get("/api/settings/ai/models"));
			}
		} catch (err) {
			message = err.message;
			messageKind = "error";
		}
		render(view);
	}

	function render(view) {
		if (!view) {
			mount(header("설정", [homeLink()]), banner(message ?? "설정을 불러오지 못했습니다."));
			return;
		}

		const sameProvider = draftProvider === view.provider;
		mount(
			...[
				header("설정", [homeLink()]),
				message ? banner(message, messageKind) : null,
				providerCard(view),
				keyCard(view, sameProvider),
				view.ai.configured && sameProvider && models.length > 0 ? modelCard(view) : null,
				guideCard(),
			].filter(Boolean),
		);
	}

	function homeLink() {
		return el("a", { class: "btn btn--ghost", href: "/parent", "data-link": true, text: "← 홈" });
	}

	function providerCard(view) {
		return el("section", { class: "card" }, [
			el("h2", { class: "section-title", text: "AI 제공자" }),
			el("p", {
				class: "hint",
				text: "둘 중 하나의 API Key 만 있으면 됩니다. Gemini 는 결제 수단 없이 무료로 시작할 수 있고, OpenAI 는 상위 모델을 쓸 수 있습니다.",
			}),
			el(
				"div",
				{ class: "row" },
				view.providers.map((p) =>
					el("button", {
						class: draftProvider === p.name ? "btn" : "btn btn--secondary",
						type: "button",
						text: p.label,
						"aria-pressed": draftProvider === p.name,
						onClick: () => {
							if (draftProvider === p.name) return;
							draftProvider = p.name;
							models = [];
							message = null;
							refresh();
						},
					}),
				),
			),
			view.ai.configured && draftProvider !== view.provider
				? el("p", {
						class: "status status--warn",
						text: `현재 등록된 키는 ${labelOf(view, view.provider)} 것입니다. ${labelOf(view, draftProvider)} 키를 저장하면 교체됩니다.`,
					})
				: null,
		]);
	}

	const labelOf = (view, name) => view.providers.find((p) => p.name === name)?.label ?? name;

	function keyCard(view, sameProvider) {
		const apiKey = field("API Key", {
			type: "password",
			autocomplete: "off",
			placeholder: draftProvider === "gemini" ? "AIza..." : "sk-...",
			required: true,
		});

		const status =
			view.ai.configured && sameProvider
				? el("p", { class: "status status--ok" }, [
						el("strong", { text: "등록됨" }),
						` · ${labelOf(view, view.provider)} · 끝 4자리 ${view.ai.last4}`,
					])
				: el("p", {
						class: "status status--warn",
						text: `${labelOf(view, draftProvider)} 키가 아직 등록되지 않았습니다.`,
					});

		const form = el("form", { class: "card" }, [
			el("h2", { class: "section-title", text: `${labelOf(view, draftProvider)} API Key` }),
			status,
			el("p", {
				class: "hint",
				text: "키는 서버에서 암호화해 보관하며, 저장 후에는 다시 보여드리지 않습니다. AI 호출은 모두 서버에서만 일어납니다.",
			}),
			apiKey.wrap,
			el("div", { class: "row" }, [
				el("button", {
					class: "btn",
					type: "submit",
					text: view.ai.configured && sameProvider ? "키 교체" : "저장",
				}),
				view.ai.configured
					? el("button", {
							class: "btn btn--danger",
							type: "button",
							text: "삭제",
							onClick: async () => {
								if (!confirmAction("등록된 API Key 를 삭제할까요?\n삭제하면 문제를 생성할 수 없습니다.")) return;
								try {
									await del("/api/settings/ai-key");
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
			form.querySelector("button[type=submit]").disabled = true;
			try {
				const result = await put("/api/settings/ai-key", {
					provider: draftProvider,
					apiKey: apiKey.input.value,
				});
				models = result.models;
				// 키는 저장됐지만 실제 호출이 막혀 있는 경우(크레딧 부족 등)는 경고로 알린다.
				message = result.warning ?? "API Key 를 확인하고 저장했습니다.";
				messageKind = result.warning ? "error" : "info";
			} catch (err) {
				message = err.message;
				messageKind = "error";
			}
			await refresh();
		});

		return form;
	}

	function modelCard(view) {
		const model = selectField("문제 생성 모델", models, view.ai.model);
		const visionModel = selectField("책 표지 인식 모델", models, view.ai.visionModel);

		const form = el("form", { class: "card" }, [
			el("h2", { class: "section-title", text: "모델" }),
			el("p", {
				class: "hint",
				text: "이 계정에서 쓸 수 있는 모델만 보입니다. 위쪽일수록 최신이며, 잘 모르겠다면 그대로 두세요.",
			}),
			el("p", {
				class: "hint",
				text: "모델에 따라 문제 품질과 비용이 함께 달라집니다. 비용을 아끼려면 이름에 mini·nano·lite 가 붙은 모델을, 품질을 높이려면 pro 가 붙은 모델을 골라 보세요.",
			}),
			model.wrap,
			visionModel.wrap,
			el("button", { class: "btn", type: "submit", text: "모델 저장" }),
		]);

		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			try {
				await put("/api/settings/ai/models", {
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

	/** §25 — 선택한 제공자의 키를 어디서 어떻게 받는지 안내. */
	function guideCard() {
		const guide = GUIDES[draftProvider] ?? GUIDES.openai;

		return el("section", { class: "card card--muted" }, [
			el("h2", { class: "section-title", text: guide.title }),
			el("ol", { class: "steps" }, guide.steps.map((text) => el("li", { text }))),
			el("p", { class: "hint", text: guide.note }),
			el("p", {
				class: "hint",
				text: "키는 비밀번호와 같습니다. 다른 사람에게 공유하지 마시고, 유출된 것 같으면 발급처에서 즉시 폐기한 뒤 새 키를 등록해 주세요.",
			}),
			el("p", {
				class: "hint",
				text: "문제 20개를 만드는 데 AI 호출이 보통 4번 일어납니다. 비용은 등록하신 키로 청구됩니다.",
			}),
		]);
	}
}
