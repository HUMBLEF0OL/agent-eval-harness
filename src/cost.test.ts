import { describe, expect, it } from "vitest";
import {
  LiveBudgetLedger, PRICES, accumulate, costUsd, maxOpenAIRequestCostUsd, zeroUsage,
} from "./cost.js";
import { JUDGE_MODEL, type UsageTotals } from "./types.js";

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

  it("prices a second model off its own row, not off one hardcoded rate", () => {
    // gpt-5-nano: in 0.05, cached 0.005, out 0.40 per 1M — the arm every recorded
    // sweep actually ran on, so a wrong row here misprices the published numbers.
    const cost = costUsd("gpt-5-nano", u({
      inputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,   // 1.25x input = 0.0625
      cacheReadTokens: 1_000_000,    // 0.005
      outputTokens: 1_000_000,       // 0.40
    }));
    expect(cost).toBeCloseTo(0.05 + 0.0625 + 0.005 + 0.40, 6);
  });

  it("can price the judge model, or --judge would abort every sweep it runs on", () => {
    // JUDGE_MODEL is billed like any other call and runSweep costs it, so a missing
    // price row here turns `--judge` into a guaranteed mid-sweep throw.
    expect(PRICES[JUDGE_MODEL]).toBeDefined();
    expect(() => costUsd(JUDGE_MODEL, zeroUsage())).not.toThrow();
    // And it must not be a model under test — self-judging is not a check.
    expect(JUDGE_MODEL).not.toBe("gpt-5-nano");
  });

  it("has no price entry for gpt-5.6 — unverified pricing must not be guessed", () => {
    expect(PRICES["gpt-5.6"]).toBeUndefined();
  });

  it("prices only models this harness can actually call", () => {
    // The rule the removed Gemini rows lived under, kept as a check instead of a
    // comment: a price row for a model with no adapter behind it is an invitation to
    // configure a variant that cannot run, and it would be priced convincingly.
    expect(Object.values(PRICES).every(p => p.provider === "openai")).toBe(true);
    expect(PRICES["gemini-2.5-flash"]).toBeUndefined();
    expect(() => costUsd("gemini-2.5-flash", zeroUsage())).toThrow(/no price for model/);
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

describe("LiveBudgetLedger", () => {
  it("rejects caps too large for safe integer nanodollar accounting", () => {
    expect(() => new LiveBudgetLedger(1e308)).toThrow(/safe nanodollar range/);
  });

  it("never reserves beyond the shared cap under concurrent admissions", async () => {
    const ledger = new LiveBudgetLedger(0.25);
    let openGate!: () => void;
    const gate = new Promise<void>(resolve => { openGate = resolve; });

    const attempts = [0.10, 0.10, 0.10].map(async estimatedUsd => {
      await gate;
      return ledger.tryReserve(estimatedUsd);
    });

    openGate();
    const reservations = await Promise.all(attempts);

    expect(reservations.filter(r => r !== null)).toHaveLength(2);
    expect(reservations.filter(r => r === null)).toHaveLength(1);
    expect(ledger.snapshot().reservedUsd).toBeCloseTo(0.20);
    expect(ledger.snapshot().remainingUsd).toBeCloseTo(0.05);
  });

  it("settles at actual cost and releases the unused reservation", () => {
    const ledger = new LiveBudgetLedger(0.25);
    const reservation = ledger.tryReserve(0.20);

    expect(reservation).not.toBeNull();
    reservation!.settle(0.08);

    expect(ledger.snapshot()).toEqual({
      capUsd: 0.25,
      spentUsd: 0.08,
      reservedUsd: 0,
      quarantinedUsd: 0,
      remainingUsd: 0.17,
    });
  });

  it("quarantines a failed request reservation instead of releasing it", () => {
    const ledger = new LiveBudgetLedger(0.25);
    const reservation = ledger.tryReserve(0.20);

    expect(reservation).not.toBeNull();
    reservation!.quarantine();

    expect(ledger.snapshot()).toEqual({
      capUsd: 0.25,
      spentUsd: 0,
      reservedUsd: 0,
      quarantinedUsd: 0.20,
      remainingUsd: 0.05,
    });
    expect(ledger.tryReserve(0.06)).toBeNull();
  });
});

describe("maxOpenAIRequestCostUsd", () => {
  it("reserves the full verified context plus configured output", () => {
    expect(maxOpenAIRequestCostUsd("gpt-5-nano", 16_000)).toBeCloseTo(0.0264, 8);
    expect(maxOpenAIRequestCostUsd("gpt-5-mini", 2_000)).toBeCloseTo(0.104, 8);
  });

  it("rejects priced models without a verified hard-budget profile", () => {
    expect(() => maxOpenAIRequestCostUsd("gpt-5.6-terra", 16_000))
      .toThrow(/no verified OpenAI hard-budget profile/);
  });
});
