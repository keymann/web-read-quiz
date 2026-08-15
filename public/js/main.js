/**
 * SPA 진입점. 빌드 단계 없이 브라우저가 ES module 을 그대로 로드한다.
 * 화면은 `pages/` 아래에 하나씩 추가하고 여기서 라우터에 등록한다.
 */
import { bookAddPage } from "./pages/book-add.js";
import { bookDetailPage } from "./pages/book-detail.js";
import { bookListPage } from "./pages/book-list.js";
import { childHomePage } from "./pages/child-home.js";
import { childHistoryPage } from "./pages/child-history.js";
import { childManagementPage } from "./pages/child-management.js";
import { loginPage } from "./pages/login.js";
import { parentHomePage } from "./pages/parent-home.js";
import { quizPlayPage } from "./pages/quiz-play.js";
import { quizResultPage } from "./pages/quiz-result.js";
import { quizReviewPage } from "./pages/quiz-review.js";
import { settingsPage } from "./pages/settings.js";
import { navigate, register, setNotFound, start } from "./router.js";
import { homePathFor, loadSession } from "./session.js";

register("/login", loginPage);
register("/parent", parentHomePage);
register("/parent/children", childManagementPage);
register("/parent/children/:id", childHistoryPage);
register("/parent/settings", settingsPage);
register("/parent/settings/:tab", settingsPage);
// `/new` 는 :id 패턴과 세그먼트 수가 같으므로 먼저 등록해야 한다.
register("/parent/books/new", bookAddPage);
register("/parent/books", bookListPage);
register("/parent/books/:id", bookDetailPage);
register("/parent/quizzes/:id", quizReviewPage);
register("/child", childHomePage);
register("/child/quizzes/:id", quizPlayPage);
register("/child/results/:id", quizResultPage);

// 루트는 로그인 상태에 따라 갈라진다.
register("/", async () => {
	const s = await loadSession();
	return navigate(s ? homePathFor(s.role) : "/login", { replace: true });
});

setNotFound(() => navigate("/", { replace: true }));

start();
