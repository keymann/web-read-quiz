/**
 * DOM 도우미.
 *
 * 사용자·AI 가 만든 문자열은 전부 `textContent` 로 넣는다. `innerHTML` 은 쓰지 않는다(§26 XSS).
 * CSP 가 `style-src 'self'` 이므로 인라인 style 속성도 쓰지 않고 클래스만 쓴다.
 */

export function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);

	for (const [key, value] of Object.entries(props)) {
		if (value === undefined || value === null || value === false) continue;
		if (key === "class") node.className = value;
		else if (key === "text") node.textContent = String(value);
		else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
		else node.setAttribute(key, value === true ? "" : String(value));
	}

	for (const child of [].concat(children)) {
		if (child === null || child === undefined || child === false) continue;
		node.append(typeof child === "string" ? document.createTextNode(child) : child);
	}
	return node;
}

/** 조건부 자리(`cond ? node : null`)를 그대로 넘길 수 있도록 빈 값을 걸러낸다. */
export function mount(...nodes) {
	const app = document.getElementById("app");
	app.replaceChildren(...nodes.filter((node) => node !== null && node !== undefined && node !== false));
	return app;
}

export const setKidMode = (on) => document.getElementById("app").classList.toggle("kid", on);

/** 화면 상단 알림. 성공/실패 모두 같은 자리에 띄운다. */
export function banner(message, kind = "error") {
	return el("p", { class: `banner banner--${kind}`, role: "alert", text: message });
}

export function field(label, inputProps) {
	const input = el("input", { class: "input", ...inputProps });
	const wrap = el("label", { class: "field" }, [el("span", { class: "field__label", text: label }), input]);
	return { wrap, input };
}

export function header(title, actions = []) {
	return el("header", { class: "page-header" }, [
		el("h1", { class: "page-title", text: title }),
		el("div", { class: "page-actions" }, actions),
	]);
}

/** 파괴적 동작 전 확인. 브라우저 기본 confirm 으로 충분한 자리에만 쓴다. */
export const confirmAction = (message) => window.confirm(message);
