/** 모든 PK 는 UUID v4. D1 에서는 TEXT 로 저장한다. */
export const newId = (): string => crypto.randomUUID();

/** 현재 시각을 스키마와 같은 ISO8601 UTC 문자열로. */
export const nowIso = (): string => new Date().toISOString().replace(/(\.\d{3})Z$/, "$1Z");
