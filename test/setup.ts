import { applyD1Migrations, env } from "cloudflare:test";

// 각 테스트 워커가 시작될 때 빈 D1 에 스키마를 적용한다.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
