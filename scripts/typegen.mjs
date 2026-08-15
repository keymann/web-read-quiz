/**
 * `wrangler types` 래퍼.
 *
 * wrangler 는 `.dev.vars` 와 `.env` 에 있는 값까지 읽어 Env 타입에 넣는다. 그러면 커밋되는
 * worker-configuration.d.ts 가 **로컬에 어떤 시크릿 파일이 있느냐에 따라 달라진다.**
 * (실제로 개발용 OPENAI_API_KEY 이름이 타입에 섞여 들어온 적이 있다)
 *
 * 타입에는 wrangler.jsonc 의 바인딩만 담기게 하고, Secret 은 src/types.ts 의 `AppEnv` 에서
 * 명시적으로 선언한다. 그래야 어디서 생성하든 같은 파일이 나온다.
 */
import { renameSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const HIDDEN = [".dev.vars", ".env"];
const moved = [];

for (const file of HIDDEN) {
	if (existsSync(file)) {
		renameSync(file, `${file}.typegen-bak`);
		moved.push(file);
	}
}

try {
	execFileSync("npx", ["wrangler", "types"], { stdio: "inherit" });
} finally {
	for (const file of moved) renameSync(`${file}.typegen-bak`, file);
}
