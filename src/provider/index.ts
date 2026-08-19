import type { Provider, ProviderId } from "../types.js";
import { openaiProvider } from "./openai.js";

/** One adapter, behind the seam rather than in front of it. `Record<ProviderId, …>`
 *  is kept for the same reason `requireKey`'s table is: adding a provider is then a
 *  compile error here until it is registered, which is the only place that check is
 *  cheap. See the removal notes in README for the two adapters that used to be here. */
export const PROVIDERS: Record<ProviderId, Provider> = {
  openai: openaiProvider,
};
