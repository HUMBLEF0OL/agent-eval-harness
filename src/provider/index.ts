import type { Provider, ProviderId } from "../types.js";
import { googleProvider } from "./google.js";
import { openaiProvider } from "./openai.js";

export const PROVIDERS: Record<ProviderId, Provider> = {
  openai: openaiProvider,
  google: googleProvider,
};
