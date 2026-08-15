import type { AppEnv } from "../types";
import type { ProviderName } from "../ai/types";

/** `parent_settings` 테이블 접근. API Key 는 암호문·IV 로만 오간다. */

export interface ParentSettingsRow {
	user_id: string;
	ai_provider: ProviderName;
	api_key_cipher: string | null;
	api_key_iv: string | null;
	api_key_last4: string | null;
	text_model: string | null;
	vision_model: string | null;
	created_at: string;
	updated_at: string;
}

export async function find(env: AppEnv, userId: string): Promise<ParentSettingsRow | null> {
	return env.DB.prepare("SELECT * FROM parent_settings WHERE user_id = ?")
		.bind(userId)
		.first<ParentSettingsRow>();
}

export interface StoredKey {
	provider: ProviderName;
	cipher: string;
	iv: string;
	last4: string;
}

/**
 * 제공자를 바꾸면 이전 제공자의 키·모델은 의미가 없다. 함께 갈아치운다.
 * 남겨 두면 다음에 그 제공자로 돌아왔을 때 만료된 키가 되살아나 원인 모를 실패를 만든다.
 */
export async function saveKey(env: AppEnv, userId: string, key: StoredKey): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO parent_settings (user_id, ai_provider, api_key_cipher, api_key_iv, api_key_last4)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		   ai_provider    = excluded.ai_provider,
		   api_key_cipher = excluded.api_key_cipher,
		   api_key_iv     = excluded.api_key_iv,
		   api_key_last4  = excluded.api_key_last4,
		   text_model     = CASE WHEN parent_settings.ai_provider = excluded.ai_provider
		                         THEN parent_settings.text_model ELSE NULL END,
		   vision_model   = CASE WHEN parent_settings.ai_provider = excluded.ai_provider
		                         THEN parent_settings.vision_model ELSE NULL END,
		   updated_at     = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
	)
		.bind(userId, key.provider, key.cipher, key.iv, key.last4)
		.run();
}

export async function clearKey(env: AppEnv, userId: string): Promise<void> {
	await env.DB.prepare(
		`UPDATE parent_settings
		    SET api_key_cipher = NULL,
		        api_key_iv     = NULL,
		        api_key_last4  = NULL,
		        text_model     = NULL,
		        vision_model   = NULL,
		        updated_at     = strftime('%Y-%m-%dT%H:%M:%fZ','now')
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
		`INSERT INTO parent_settings (user_id, text_model, vision_model)
		 VALUES (?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		   text_model   = excluded.text_model,
		   vision_model = excluded.vision_model,
		   updated_at   = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
	)
		.bind(userId, models.model, models.visionModel)
		.run();
}
