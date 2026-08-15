-- 0003_ai_provider.sql — AI 제공자를 OpenAI 외에 Gemini 도 쓸 수 있게 한다
--
-- 컬럼 이름에 openai 가 박혀 있으면 Gemini 키를 넣었을 때 읽는 사람이 헷갈린다.
-- 제공자 중립적인 이름으로 바꾸고, 어떤 제공자의 키인지는 ai_provider 가 가리킨다.
-- 기존 행은 전부 OpenAI 키이므로 기본값이 'openai' 인 것으로 충분하다.

ALTER TABLE parent_settings ADD COLUMN ai_provider TEXT NOT NULL DEFAULT 'openai';

ALTER TABLE parent_settings RENAME COLUMN openai_api_key_cipher TO api_key_cipher;
ALTER TABLE parent_settings RENAME COLUMN openai_api_key_iv     TO api_key_iv;
ALTER TABLE parent_settings RENAME COLUMN openai_api_key_last4  TO api_key_last4;
ALTER TABLE parent_settings RENAME COLUMN openai_model          TO text_model;
ALTER TABLE parent_settings RENAME COLUMN openai_vision_model   TO vision_model;
