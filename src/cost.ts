import type { LiveBudgetReservation, ProviderId, UsageTotals } from "./types.js";

export interface Price { provider: ProviderId; in: number; cached: number; out: number }

const NANODOLLARS_PER_USD = 1_000_000_000;

export interface LiveBudgetSnapshot {
  capUsd: number;
  spentUsd: number;
  reservedUsd: number;
  quarantinedUsd: number;
  remainingUsd: number;
}

function toNanodollars(usd: number, round: "up" | "down"): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`USD amount must be finite and non-negative, got: ${usd}`);
  const nanodollars = Math[round === "up" ? "ceil" : "floor"](usd * NANODOLLARS_PER_USD);
  if (!Number.isSafeInteger(nanodollars)) {
    throw new Error(`USD amount exceeds the safe nanodollar range, got: ${usd}`);
  }
  return nanodollars;
}

/** One invocation's shared live-call budget. Admissions are synchronous, so concurrent
 *  request paths cannot interleave the capacity check and reservation mutation. */
export class LiveBudgetLedger {
  private readonly cap: number;
  private spent = 0;
  private reserved = 0;
  private quarantined = 0;

  constructor(capUsd: number) {
    if (!Number.isFinite(capUsd) || capUsd <= 0) {
      throw new Error(`live budget must be a positive finite number, got: ${capUsd}`);
    }
    this.cap = toNanodollars(capUsd, "down");
  }

  tryReserve(estimatedUsd: number): LiveBudgetReservation | null {
    const amount = toNanodollars(estimatedUsd, "up");
    if (amount <= 0) throw new Error(`reservation must be positive, got: ${estimatedUsd}`);
    if (this.spent + this.reserved + this.quarantined + amount > this.cap) return null;
    this.reserved += amount;

    let open = true;
    const finish = () => {
      if (!open) throw new Error("budget reservation has already been settled");
      open = false;
      this.reserved -= amount;
    };

    return {
      reservedUsd: amount / NANODOLLARS_PER_USD,
      settle: actualUsd => {
        const actual = toNanodollars(actualUsd, "up");
        if (actual > amount) {
          throw new Error(`actual cost $${actualUsd} exceeds reserved $${amount / NANODOLLARS_PER_USD}`);
        }
        finish();
        this.spent += actual;
      },
      quarantine: () => {
        finish();
        this.quarantined += amount;
      },
    };
  }

  snapshot(): Readonly<LiveBudgetSnapshot> {
    return {
      capUsd: this.cap / NANODOLLARS_PER_USD,
      spentUsd: this.spent / NANODOLLARS_PER_USD,
      reservedUsd: this.reserved / NANODOLLARS_PER_USD,
      quarantinedUsd: this.quarantined / NANODOLLARS_PER_USD,
      remainingUsd: (this.cap - this.spent - this.reserved - this.quarantined) / NANODOLLARS_PER_USD,
    };
  }
}

/** USD per million tokens. Verified 2026-08-16.
 *  `gpt-5.6` (non-Terra) is deliberately absent — its pricing was not verified. */
export const PRICES: Record<string, Price> = {
  "gpt-5.6-terra":    { provider: "openai",    in: 2.00, cached: 0.20,  out: 12.00 },
  "gpt-5-nano":       { provider: "openai",    in: 0.05, cached: 0.005, out:  0.40 },
  // gpt-5-mini exists here to be the JUDGE (see JUDGE_MODEL in types.ts), not a model
  // under test: a model grading its own patch is not a check, which is why runSweep
  // refuses that pairing. Both rows re-read off developers.openai.com/api/docs/pricing
  // on 2026-08-17, which also confirmed the gpt-5-nano row above unchanged.
  "gpt-5-mini":       { provider: "openai",    in: 0.25, cached: 0.025, out:  2.00 },
  // Sonnet 5 rate is introductory, expires 2026-08-31; then 3.00 / 0.30 / 15.00.
  // Read off Google's own pricing page (ai.google.dev/gemini-api/docs/pricing),
  // paid text tier, on 2026-08-16. Third-party aggregators listed DIFFERENT
  // numbers for both models; the vendor page wins. `gemini-2.5-pro` is absent
  // for the same reason `gpt-5.6` is — its pricing was not verified here.
  // Only models REACHABLE with a new API key are listed. `models.list()` still
  // advertises `gemini-2.5-flash-lite`, but calling it returns 404 "no longer
  // available to new users" (verified live, 2026-08-17) — a price row for an
  // unreachable model is an invitation to configure a variant that cannot run.
  "gemini-2.5-flash":      { provider: "google", in: 0.30, cached: 0.03, out: 2.50 },
  "gemini-3.5-flash-lite": { provider: "google", in: 0.30, cached: 0.03, out: 2.50 },
  "gemini-3.5-flash":      { provider: "google", in: 1.50, cached: 0.15, out: 9.00 },
};

/** Context ceilings used for conservative request admission. A price row alone is
 *  insufficient: a model is hard-cap eligible only after its context limit is verified. */
const OPENAI_MAX_INPUT_TOKENS: Record<string, number> = {
  "gpt-5-nano": 400_000,
  "gpt-5-mini": 400_000,
};

export function maxOpenAIRequestCostUsd(model: string, maxOutputTokens: number): number {
  const price = PRICES[model];
  const maxInputTokens = OPENAI_MAX_INPUT_TOKENS[model];
  if (!price || price.provider !== "openai" || maxInputTokens === undefined) {
    throw new Error(`model ${model} has no verified OpenAI hard-budget profile`);
  }
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new Error(`max output tokens must be a positive integer, got: ${maxOutputTokens}`);
  }
  return (maxInputTokens * price.in + maxOutputTokens * price.out) / 1_000_000;
}

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
