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

	function renderForm(message) {
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
		const invite = field("초대 코드 (있는 경우)", { name: "invite" });

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
						renderForm(err.message);
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
