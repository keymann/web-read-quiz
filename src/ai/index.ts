import { gemini } from "./gemini";
import { openai } from "./openai";
import { vertex } from "./vertex";
import type { AiProvider, ProviderName } from "./types";

const PROVIDERS: Record<ProviderName, AiProvider> = { openai, gemini, vertex };

export const providerFor = (name: ProviderName): AiProvider => PROVIDERS[name];

/** 설정 화면의 제공자 선택지. */
export const providerChoices = (): { name: ProviderName; label: string; consoleUrl: string }[] =>
	Object.values(PROVIDERS).map((p) => ({ name: p.name, label: p.label, consoleUrl: p.consoleUrl }));

export type { AiProvider } from "./types";
