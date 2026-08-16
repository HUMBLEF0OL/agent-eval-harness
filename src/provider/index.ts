import type { Provider, ProviderId } from "../types.js";
import { anthropicProvider } from "./anthropic.js";
import { openaiProvider } from "./openai.js";

export const PROVIDERS: Record<ProviderId, Provider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
};
