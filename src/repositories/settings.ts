import type { AppEnv } from "../types";

/** `parent_settings` 테이블 접근. API Key 는 암호문·IV 로만 오간다. */

export interface ParentSettingsRow {
	user_id: string;
	openai_api_key_cipher: string | null;
	openai_api_key_iv: string | null;
	openai_api_key_last4: string | null;
	openai_model: string | null;
	openai_vision_model: string | null;
	created_at: string;
	updated_at: string;
}

export async function find(env: AppEnv, userId: string): Promise<ParentSettingsRow | null> {
	return env.DB.prepare("SELECT * FROM parent_settings WHERE user_id = ?")
		.bind(userId)
		.first<ParentSettingsRow>();
}

export interface StoredKey {
	cipher: string;
	iv: string;
	last4: string;
}

export async function saveKey(env: AppEnv, userId: string, key: StoredKey): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO parent_settings (user_id, openai_api_key_cipher, openai_api_key_iv, openai_api_key_last4)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		   openai_api_key_cipher = excluded.openai_api_key_cipher,
		   openai_api_key_iv     = excluded.openai_api_key_iv,
		   openai_api_key_last4  = excluded.openai_api_key_last4,
		   updated_at            = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
	)
		.bind(userId, key.cipher, key.iv, key.last4)
		.run();
}

export async function clearKey(env: AppEnv, userId: string): Promise<void> {
	await env.DB.prepare(
		`UPDATE parent_settings
		    SET openai_api_key_cipher = NULL,
		        openai_api_key_iv     = NULL,
		        openai_api_key_last4  = NULL,
		        updated_at            = strftime('%Y-%m-%dT%H:%M:%fZ','now')
		  WHERE user_id = ?`,
	)
		.bind(userId)
		.run();
}

export async function saveModels(
	env: AppEnv,
	userId: string,
	models: { model: string | null; visionModel: string | null },
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO parent_settings (user_id, openai_model, openai_vision_model)
		 VALUES (?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		   openai_model        = excluded.openai_model,
		   openai_vision_model = excluded.openai_vision_model,
		   updated_at          = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
	)
		.bind(userId, models.model, models.visionModel)
		.run();
}
