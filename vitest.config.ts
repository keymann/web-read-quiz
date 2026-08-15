import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

/**
 * 테스트는 실제 workerd 런타임 위에서 돈다. D1/KV/R2 도 실제 바인딩과 같은 구현을 쓴다.
 * 마이그레이션 SQL 을 읽어 바인딩으로 넘기고, test/setup.ts 가 각 테스트 파일 시작 전에 적용한다.
 */
export default defineWorkersConfig(async () => {
	const migrations = await readD1Migrations(path.join(__dirname, "migrations"));

	return {
		test: {
			setupFiles: ["./test/setup.ts"],
			poolOptions: {
				workers: {
					singleWorker: true,
					wrangler: { configPath: "./wrangler.jsonc" },
					miniflare: {
						bindings: {
							TEST_MIGRATIONS: migrations,
							SESSION_SECRET: "test-session-secret-not-used-in-production",
							ENCRYPTION_KEY: "dGVzdC1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcy0hIQ==",
							INVITE_CODE: "",
						},
					},
				},
			},
		},
	};
});
