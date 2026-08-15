/**
 * History API 기반 라우터.
 *
 * 서버는 알 수 없는 경로를 index.html 로 돌려주므로(`not_found_handling: single-page-application`)
 * 새로고침·직접 진입도 그대로 동작한다.
 */

const routes = [];
let notFoundView = null;

export function register(pattern, view, options = {}) {
	routes.push({ segments: pattern.split("/").filter(Boolean), view, ...options });
}

export function setNotFound(view) {
	notFoundView = view;
}

export function navigate(path, { replace = false } = {}) {
	if (replace) history.replaceState(null, "", path);
	else history.pushState(null, "", path);
	return render();
}

function match(pathname) {
	const parts = pathname.split("/").filter(Boolean);
	for (const r of routes) {
		if (r.segments.length !== parts.length) continue;
		const params = {};
		let hit = true;
		for (let i = 0; i < r.segments.length; i++) {
			const seg = r.segments[i];
			if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]);
			else if (seg !== parts[i]) {
				hit = false;
				break;
			}
		}
		if (hit) return { route: r, params };
	}
	return null;
}

export async function render() {
	const found = match(location.pathname);
	if (!found) return notFoundView ? notFoundView() : undefined;
	return found.route.view(found.params);
}

export function start() {
	// 앱 내부 링크는 전체 새로고침 없이 라우터가 처리한다.
	document.addEventListener("click", (event) => {
		const anchor = event.target.closest?.("a[data-link]");
		if (!anchor || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
		event.preventDefault();
		navigate(anchor.getAttribute("href"));
	});

	window.addEventListener("popstate", () => render());
	return render();
}
