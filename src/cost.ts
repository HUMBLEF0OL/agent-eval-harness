import type { ProviderId, UsageTotals } from "./types.js";

export interface Price { provider: ProviderId; in: number; cached: number; out: number }

/** USD per million tokens. Verified 2026-08-16.
 *  `gpt-5.6` (non-Terra) is deliberately absent — its pricing was not verified. */
export const PRICES: Record<string, Price> = {
  "gpt-5.6-terra":    { provider: "openai",    in: 2.00, cached: 0.20,  out: 12.00 },
  "gpt-5-nano":       { provider: "openai",    in: 0.05, cached: 0.005, out:  0.40 },
  // Sonnet 5 rate is introductory, expires 2026-08-31; then 3.00 / 0.30 / 15.00.
  "claude-sonnet-5":  { provider: "anthropic", in: 2.00, cached: 0.20,  out: 10.00 },
  "claude-opus-5":    { provider: "anthropic", in: 5.00, cached: 0.50,  out: 25.00 },
  "claude-haiku-4-5": { provider: "anthropic", in: 1.00, cached: 0.10,  out:  5.00 },
};

export function zeroUsage(): UsageTotals {
  return { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

export function accumulate(into: UsageTotals, add: UsageTotals): void {
  into.inputTokens      += add.inputTokens;
  into.cacheWriteTokens += add.cacheWriteTokens;
  into.cacheReadTokens  += add.cacheReadTokens;
  into.outputTokens     += add.outputTokens;
  into.reasoningTokens  += add.reasoningTokens;
}

/** Total prompt size — NOT `inputTokens`, which is the uncached remainder only. */
export function promptTokens(u: UsageTotals): number {
  return u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens;
}

export function costUsd(model: string, u: UsageTotals): number {
  const p = PRICES[model];
  if (!p) throw new Error(`no price for model ${model} — add it to PRICES before running`);
  // reasoningTokens is a subset of outputTokens and is deliberately not billed again.
  return (
      u.inputTokens      * p.in
    + u.cacheWriteTokens * p.in * 1.25
    + u.cacheReadTokens  * p.cached
    + u.outputTokens     * p.out
  ) / 1_000_000;
}
