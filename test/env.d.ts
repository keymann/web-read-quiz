declare module "cloudflare:test" {
	interface ProvidedEnv {
		TEST_MIGRATIONS: D1Migration[];
		SESSION_SECRET: string;
		ENCRYPTION_KEY: string;
		INVITE_CODE: string;
	}
}
