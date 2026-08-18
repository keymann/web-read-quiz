import { post } from "../api.js";
import { navigate } from "../router.js";
import { homePathFor, loadSession, setSession } from "../session.js";
import { banner, el, field, mount, setKidMode } from "../ui.js";

/** 로그인 / 회원가입. 부모·아이 모두 같은 화면을 쓰고 role 은 서버가 판단한다. */
export async function loginPage() {
	setKidMode(false);

	const existing = await loadSession();
	if (existing) return navigate(homePathFor(existing.role), { replace: true });

	let mode = "login";
	const container = el("div", { class: "auth" });
	mount(container);
	renderForm();

	/**
	 * @param message 화면 위에 띄울 알림.
	 * @param kept 실패 직전에 부모가 적어 둔 값. 다시 그릴 때 그대로 되살린다.
	 *
	 * 실패하면 폼을 통째로 다시 만드는 구조라, 예전에는 적어 둔 것이 전부 사라졌다.
	 * 초대 코드가 필수가 되면서 이 실패는 일상이 됐다 — 코드 한 글자를 틀렸다고
	 * 아이디·비밀번호·이름까지 다시 치게 할 수는 없다.
	 */
	function renderForm(message, kept = {}) {
		const isSignup = mode === "signup";

		const loginId = field("아이디", { name: "loginId", autocomplete: "username", required: true });
		const password = field("비밀번호", {
			type: "password",
			name: "password",
			autocomplete: isSignup ? "new-password" : "current-password",
			required: true,
		});
		const password2 = field("비밀번호 확인", { type: "password", name: "password2", required: true });
		const displayName = field("이름", { name: "displayName", required: true });
		// 초대 코드 없이는 가입되지 않는다. "(있는 경우)" 는 넣어도 그만인 것처럼 읽혀
		// 비운 채로 제출하게 만든다.
		const invite = field("초대 코드", { name: "invite", required: true });

		// 값은 속성이 아니라 프로퍼티로 넣는다. 비밀번호가 DOM 속성에 남지 않게 한다.
		for (const [f, key] of [
			[loginId, "loginId"],
			[password, "password"],
			[password2, "password2"],
			[displayName, "displayName"],
			[invite, "invite"],
		]) {
			if (kept[key]) f.input.value = kept[key];
		}

		const submit = el("button", { class: "btn btn--block", type: "submit", text: isSignup ? "가입하기" : "로그인" });

		const form = el(
			"form",
			{
				class: "card auth__card",
				onSubmit: async (event) => {
					event.preventDefault();
					submit.disabled = true;
					try {
						const data = isSignup
							? await post("/api/auth/signup", {
									loginId: loginId.input.value,
									password: password.input.value,
									password2: password2.input.value,
									displayName: displayName.input.value,
									invite: invite.input.value,
								})
							: await post("/api/auth/login", {
									loginId: loginId.input.value,
									password: password.input.value,
								});
						setSession(data);
						await navigate(homePathFor(data.role), { replace: true });
					} catch (err) {
						submit.disabled = false;
						renderForm(err.message, {
							loginId: loginId.input.value,
							password: password.input.value,
							password2: password2.input.value,
							displayName: displayName.input.value,
							invite: invite.input.value,
						});
					}
				},
			},
			[
				el("h1", { class: "auth__title", text: "AI 독서 퀴즈" }),
				el("p", {
					class: "auth__lead",
					text: isSignup ? "부모 계정을 만듭니다. 아이 계정은 가입 후 추가할 수 있어요." : "부모·아이 모두 이곳에서 로그인합니다.",
				}),
				message ? banner(message) : null,
				loginId.wrap,
				password.wrap,
				isSignup ? password2.wrap : null,
				isSignup ? displayName.wrap : null,
				isSignup ? invite.wrap : null,
				submit,
				el("button", {
					class: "btn btn--ghost btn--block",
					type: "button",
					text: isSignup ? "이미 계정이 있어요 — 로그인" : "부모 계정 만들기",
					onClick: () => {
						mode = isSignup ? "login" : "signup";
						renderForm();
					},
				}),
			],
		);

		container.replaceChildren(form);
		loginId.input.focus();
	}
}
