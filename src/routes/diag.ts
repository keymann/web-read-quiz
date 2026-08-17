import { requireParent } from "../auth/guards";
import { rateLimit } from "../utils/ratelimit";
import { ok } from "../utils/response";
import { route, type Route, type RouteCtx } from "./router";

/**
 * 임시 진단 경로 — **국내 서지 API 연동 Phase 0-1 확인용이며 확인 후 제거한다.**
 *
 * 왜 필요한가: Gemini 를 배포 환경에서 부를 수 없다는 사실(Cloudflare 가 홍콩 콜로에서
 * 나가고 홍콩은 Gemini 미지원 지역)을 **전부 구현한 뒤에** 알았다. 알라딘·카카오에 붙이기
 * 전에 같은 것을 먼저 확인한다 — 못 닿으면 계획 자체를 다시 짜야 한다.
 *
 * 키가 없어도 판정된다. 두 API 는 인증 실패 시 **서로 구별되는** 오류를 주기 때문이다.
 * 그래서 없는 엔드포인트를 **대조군**으로 함께 부른다 — 응답만 보고 "닿았다" 고 착각하지
 * 않기 위해서다(네이버의 401 은 없는 경로도 똑같이 준다).
 */

/**
 * 확인할 대상. **클라이언트가 URL 을 정하지 못한다.**
 *
 * URL 을 파라미터로 받으면 이 워커가 임의의 주소를 대신 부르는 통로(SSRF)가 된다.
 * 목록을 코드에 박아 두는 것이 이 진단의 유일한 안전한 형태다.
 */
const TARGETS = [
	{
		name: "aladin-search",
		note: "알라딘 ItemSearch",
		url:
			"https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?ttbkey=diag&Query=%EB%A7%88%EB%8B%B9%EC%9D%84+%EB%82%98%EC%98%A8+%EC%95%94%ED%83%89" +
			"&QueryType=Title&MaxResults=1&start=1&SearchTarget=Book&output=js&Version=20131101",
	},
	{
		name: "aladin-lookup",
		note: "알라딘 ItemLookUp (ISBN)",
		url:
			"https://www.aladin.co.kr/ttb/api/ItemLookUp.aspx?ttbkey=diag&itemIdType=ISBN13" +
			"&ItemId=9788958282242&output=js&Version=20131101",
	},
	{
		// 대조군. 알라딘은 없는 엔드포인트에 HTML 을 주므로 위 둘의 JSON 오류가 진짜 API 응답임을 증명한다.
		name: "aladin-control",
		note: "대조군 — 알라딘의 없는 엔드포인트",
		url: "https://www.aladin.co.kr/ttb/api/Nonsense.aspx?ttbkey=diag&output=js",
	},
	{
		name: "kakao-book",
		note: "카카오 책 검색",
		url: "https://dapi.kakao.com/v3/search/book?query=%EB%A7%88%EB%8B%B9%EC%9D%84+%EB%82%98%EC%98%A8+%EC%95%94%ED%83%89",
	},
	{
		// 대조군. 카카오는 없는 경로에 404 를 주므로 위의 401 이 "경로는 있다" 는 뜻이 된다.
		name: "kakao-control",
		note: "대조군 — 카카오의 없는 경로",
		url: "https://dapi.kakao.com/v3/search/nonsense?query=test",
	},
	{
		name: "naver-book",
		note: "네이버 책 검색 (종료 여부 확인 불가 — 아래 대조군과 비교)",
		url: "https://openapi.naver.com/v1/search/book.json?query=test",
	},
	{
		name: "naver-control",
		note: "대조군 — 네이버의 없는 경로",
		url: "https://openapi.naver.com/v1/search/nonsense.json?query=test",
	},
] as const;

const TIMEOUT_MS = 10_000;
/** 본문은 판정에 필요한 만큼만. 통째로 실어 보내면 진단이 아니라 프록시가 된다. */
const EXCERPT = 200;

async function probe(target: (typeof TARGETS)[number]) {
	const started = Date.now();
	try {
		const res = await fetch(target.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		const body = (await res.text()).slice(0, EXCERPT);

		return {
			name: target.name,
			note: target.note,
			reached: true,
			status: res.status,
			contentType: res.headers.get("content-type"),
			ms: Date.now() - started,
			excerpt: body,
		};
	} catch (err) {
		// 여기 걸리는 것이 우리가 두려워하는 결과다 — 지역 차단·DNS·TLS 어느 쪽이든 "못 닿음".
		return {
			name: target.name,
			note: target.note,
			reached: false,
			status: null,
			contentType: null,
			ms: Date.now() - started,
			excerpt: err instanceof Error ? err.message : String(err),
		};
	}
}

async function egress({ env, request, principal }: RouteCtx): Promise<Response> {
	const parent = requireParent(principal);
	await rateLimit(env, "diag", parent.userId, 20, 60 * 60);

	const results = await Promise.all(TARGETS.map(probe));

	return ok({
		// 이 워커가 어느 지역에서 나가는지. Gemini 차단의 원인이 바로 이 값이었다.
		colo: request.headers.get("cf-ray")?.split("-").pop() ?? null,
		results,
	});
}

export const diagRoutes: Route[] = [route("GET", "/api/diag/egress", egress)];
