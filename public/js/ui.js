/**
 * DOM 도우미.
 *
 * 사용자·AI 가 만든 문자열은 전부 `textContent` 로 넣는다. `innerHTML` 은 쓰지 않는다(§26 XSS).
 * CSP 가 `style-src 'self'` 이므로 인라인 style 속성도 쓰지 않고 클래스만 쓴다.
 */

/**
 * 링크·이미지 주소로 받아들일 스킴.
 *
 * 이 앱에는 **AI 와 외부 API 가 만든 URL** 이 화면에 링크로 붙는다(참고 자료). `javascript:` 나
 * `data:text/html` 이 섞여 들어오면 부모가 누르는 순간 우리 오리진에서 실행된다. 렌더링이
 * `el()` 한 곳을 지나므로 여기서 한 번 막으면 지금 있는 링크도, 앞으로 생길 링크도 덮인다.
 *
 * 서버도 저장 시점에 같은 검사를 한다(`services/book.ts`). 어느 한 쪽만으로는 부족하다 —
 * 서버 검사는 이미 저장된 데이터를 못 고치고, 이 검사는 서버를 거치지 않는 값을 못 본다.
 */
const SAFE_URL = /^(https?:|mailto:|\/|#|\?)/i;

const isSafeUrl = (value) => SAFE_URL.test(String(value).trim());

export function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);

	for (const [key, value] of Object.entries(props)) {
		if (value === undefined || value === null || value === false) continue;
		if (key === "class") node.className = value;
		else if (key === "text") node.textContent = String(value);
		else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
		else if ((key === "href" || key === "src") && !isSafeUrl(value)) {
			// 조용히 버리지 않는다. 링크가 사라진 이유를 콘솔에서 찾을 수 있어야 한다.
			console.warn(`허용되지 않은 주소를 건너뜁니다: ${key}`);
		} else node.setAttribute(key, value === true ? "" : String(value));
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

/**
 * 여러 줄 입력. 서비스 계정 JSON 처럼 긴 값을 붙여넣을 때 쓴다.
 *
 * `value` 는 속성이 아니라 프로퍼티로 넣는다. `<textarea>` 의 내용은 자식 텍스트에서 오므로
 * `setAttribute("value", …)` 는 아무 일도 하지 않는다 — 미리 채워 넣으려다 빈 칸이 뜬다.
 */
export function textareaField(label, { value, ...props } = {}) {
	const input = el("textarea", { class: "textarea", ...props });
	if (value !== undefined && value !== null) input.value = String(value);
	const wrap = el("label", { class: "field" }, [el("span", { class: "field__label", text: label }), input]);
	return { wrap, input };
}

/** `options` 는 문자열 배열이거나 `{ value, label }` 배열. 값과 표시가 다를 때 후자를 쓴다. */
export function selectField(label, options, selected) {
	const select = el("select", { class: "select" });
	for (const option of options) {
		const value = typeof option === "string" ? option : option.value;
		const text = typeof option === "string" ? option : option.label;
		select.append(el("option", { value, text, selected: value === selected }));
	}
	const wrap = el("label", { class: "field" }, [el("span", { class: "field__label", text: label }), select]);
	return { wrap, select };
}

export function header(title, actions = []) {
	return el("header", { class: "page-header" }, [
		el("h1", { class: "page-title", text: title }),
		el("div", { class: "page-actions" }, actions),
	]);
}

/** 파괴적 동작 전 확인. 브라우저 기본 confirm 으로 충분한 자리에만 쓴다. */
export const confirmAction = (message) => window.confirm(message);
