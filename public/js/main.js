/**
 * SPA 진입점. 빌드 단계 없이 브라우저가 ES module 을 그대로 로드한다.
 * 화면은 `pages/` 아래에 하나씩 추가하고 여기서 라우터에 등록한다.
 */
import { childHomePage } from "./pages/child-home.js";
import { childManagementPage } from "./pages/child-management.js";
import { loginPage } from "./pages/login.js";
import { parentHomePage } from "./pages/parent-home.js";
import { navigate, register, setNotFound, start } from "./router.js";
import { homePathFor, loadSession } from "./session.js";

register("/login", loginPage);
register("/parent", parentHomePage);
register("/parent/children", childManagementPage);
register("/child", childHomePage);

// 루트는 로그인 상태에 따라 갈라진다.
register("/", async () => {
	const s = await loadSession();
	return navigate(s ? homePathFor(s.role) : "/login", { replace: true });
});

setNotFound(() => navigate("/", { replace: true }));

start();
