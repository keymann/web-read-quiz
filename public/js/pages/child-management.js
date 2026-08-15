import { del, get, patch, post } from "../api.js";
import { requireSession } from "../session.js";
import { banner, confirmAction, el, field, header, mount, setKidMode } from "../ui.js";

/** 아이 관리 — 추가 / 수정 / 비활성화. 아이의 로그인 계정도 여기서 만든다. */
export async function childManagementPage() {
	setKidMode(false);
	const s = await requireSession("PARENT");
	if (!s) return;

	let message = null;
	let messageKind = "error";
	await refresh();

	async function refresh() {
		let children = [];
		try {
			({ children } = await get("/api/children"));
		} catch (err) {
			message = err.message;
		}
		render(children);
	}

	function render(children) {
		mount(
			header("아이 관리", [
				el("a", { class: "btn btn--ghost", href: "/parent", "data-link": true, text: "← 홈" }),
			]),
			message ? banner(message, messageKind) : null,
			el("section", { class: "card" }, [
				el("h2", { class: "section-title", text: `등록된 아이 ${children.length}명` }),
				children.length === 0
					? el("p", { class: "hint", text: "아래에서 아이를 추가해 주세요." })
					: el(
							"ul",
							{ class: "list" },
							children.map((child) => childRow(child)),
						),
			]),
			addForm(),
		);
	}

	function childRow(child) {
		const name = field("이름", { value: child.name, required: true });
		const grade = field("학년", { type: "number", min: "1", max: "6", value: child.grade ?? "" });
		const password = field("새 비밀번호 (변경할 때만)", { type: "password", autocomplete: "new-password" });

		const editor = el("form", { class: "list__editor is-hidden" }, [
			name.wrap,
			grade.wrap,
			password.wrap,
			el("div", { class: "row" }, [
				el("button", { class: "btn", type: "submit", text: "저장" }),
				el("button", {
					class: "btn btn--danger",
					type: "button",
					text: "삭제",
					onClick: async () => {
						if (!confirmAction(`${child.name} 을(를) 삭제할까요?\n지난 풀이 기록은 그대로 보관됩니다.`)) return;
						try {
							await del(`/api/children/${child.id}`);
							message = `${child.name} 을(를) 삭제했습니다.`;
							messageKind = "info";
						} catch (err) {
							message = err.message;
							messageKind = "error";
						}
						await refresh();
					},
				}),
			]),
		]);

		editor.addEventListener("submit", async (event) => {
			event.preventDefault();
			const body = { name: name.input.value, grade: grade.input.value === "" ? null : Number(grade.input.value) };
			if (password.input.value !== "") body.password = password.input.value;
			try {
				await patch(`/api/children/${child.id}`, body);
				message = "저장했습니다.";
				messageKind = "info";
			} catch (err) {
				message = err.message;
				messageKind = "error";
			}
			await refresh();
		});

		return el("li", { class: "list__item list__item--stacked" }, [
			el("div", { class: "list__main" }, [
				el("span", { class: "list__title", text: child.name }),
				el("span", {
					class: "list__meta",
					text: child.grade ? `${child.grade}학년 · 아이디 ${child.loginId}` : `아이디 ${child.loginId}`,
				}),
			]),
			el("button", {
				class: "btn btn--secondary",
				type: "button",
				text: "수정",
				onClick: () => editor.classList.toggle("is-hidden"),
			}),
			editor,
		]);
	}

	function addForm() {
		const name = field("이름", { required: true });
		const grade = field("학년 (1~6)", { type: "number", min: "1", max: "6" });
		const loginId = field("아이 로그인 아이디", { required: true, autocomplete: "off" });
		const password = field("아이 비밀번호 (4자 이상)", { type: "password", required: true, autocomplete: "new-password" });

		const form = el("form", { class: "card" }, [
			el("h2", { class: "section-title", text: "아이 추가" }),
			el("p", { class: "hint", text: "아이가 직접 로그인해 문제를 풉니다. 아이디와 비밀번호를 함께 만들어 주세요." }),
			name.wrap,
			grade.wrap,
			loginId.wrap,
			password.wrap,
			el("button", { class: "btn btn--block", type: "submit", text: "추가하기" }),
		]);

		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			try {
				await post("/api/children", {
					name: name.input.value,
					grade: grade.input.value === "" ? null : Number(grade.input.value),
					loginId: loginId.input.value,
					password: password.input.value,
				});
				message = `${name.input.value} 을(를) 추가했습니다.`;
				messageKind = "info";
			} catch (err) {
				message = err.message;
				messageKind = "error";
			}
			await refresh();
		});

		return form;
	}
}
