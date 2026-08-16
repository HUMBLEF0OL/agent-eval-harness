import { describe, expect, it } from "vitest";
import { PRICES, accumulate, costUsd, zeroUsage } from "./cost.js";
import type { UsageTotals } from "./types.js";

const u = (p: Partial<UsageTotals>): UsageTotals => ({ ...zeroUsage(), ...p });

describe("costUsd", () => {
  it("throws on an unknown model rather than reporting $0", () => {
    expect(() => costUsd("gpt-9-imaginary", zeroUsage())).toThrow(/no price for model/);
  });

  it("prices each token category at its own rate", () => {
    // gpt-5.6-terra: in 2.00, cached 0.20, out 12.00 per 1M
    const cost = costUsd("gpt-5.6-terra", u({
      inputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,   // 1.25x input = 2.50
      cacheReadTokens: 1_000_000,    // 0.20
      outputTokens: 1_000_000,       // 12.00
    }));
    expect(cost).toBeCloseTo(2.0 + 2.5 + 0.2 + 12.0, 6);
  });

  it("does not bill reasoning tokens separately — they are inside outputTokens", () => {
    const withReasoning = costUsd("gpt-5.6-terra", u({ outputTokens: 1000, reasoningTokens: 900 }));
    const without      = costUsd("gpt-5.6-terra", u({ outputTokens: 1000, reasoningTokens: 0 }));
    expect(withReasoning).toBe(without);
  });

  it("prices each token category at its own rate for a Gemini model too", () => {
    // gemini-2.5-flash: in 0.30, cached 0.03, out 2.50 per 1M
    const cost = costUsd("gemini-2.5-flash", u({
      inputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,   // 1.25x input = 0.375
      cacheReadTokens: 1_000_000,    // 0.03
      outputTokens: 1_000_000,       // 2.50
    }));
    expect(cost).toBeCloseTo(0.30 + 0.375 + 0.03 + 2.50, 6);
  });

  it("has no price entry for gpt-5.6 — unverified pricing must not be guessed", () => {
    expect(PRICES["gpt-5.6"]).toBeUndefined();
  });

  it("has no price entry for gemini-2.5-pro — same reason", () => {
    // Google's page lists a tiered Pro rate that was not verified here, so the
    // model is unpriced and costUsd refuses it rather than inventing a number.
    expect(PRICES["gemini-2.5-pro"]).toBeUndefined();
    expect(() => costUsd("gemini-2.5-pro", zeroUsage())).toThrow(/no price for model/);
  });
});

describe("accumulate", () => {
  it("sums every category across turns", () => {
    const totals = zeroUsage();
    accumulate(totals, u({ inputTokens: 10, cacheReadTokens: 5, outputTokens: 3, reasoningTokens: 2 }));
    accumulate(totals, u({ inputTokens: 1, cacheWriteTokens: 7, outputTokens: 4, reasoningTokens: 1 }));
    expect(totals).toEqual({
      inputTokens: 11, cacheWriteTokens: 7, cacheReadTokens: 5,
      outputTokens: 7, reasoningTokens: 3,
    });
  });
});
