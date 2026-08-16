import { describe, expect, it } from "vitest";
import { bootstrapCI, summarise } from "./report.js";
import type { RunRow } from "./store.js";

const run = (over: Partial<RunRow>): RunRow => ({
  id: "x", taskId: "t", variant: "baseline", provider: "openai", model: "gpt-5.6-terra",
  effort: "high", rep: 0, startedAt: "", endedAt: null, stopReason: "end_turn", steps: 3,
  passed: 1, tampered: 0, tamperDetail: null, sourceCheat: null, sourceCheatKind: null,
  sourceCheatEvidence: null, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
  outputTokens: 0, reasoningTokens: 0, costUsd: 0.01, wallMs: 0, error: null, ...over,
});

describe("bootstrapCI", () => {
  it("is deterministic for a given seed", () => {
    const xs = [1, 0, 1, 1, 0, 1, 1, 1, 0, 1];
    expect(bootstrapCI(xs, 2000, 42)).toEqual(bootstrapCI(xs, 2000, 42));
  });

  it("brackets the sample mean", () => {
    const xs: number[] = Array.from({ length: 45 }, (_, i) => (i % 3 === 0 ? 0 : 1));
    const { lo, hi } = bootstrapCI(xs, 2000, 42);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(lo).toBeLessThanOrEqual(mean);
    expect(hi).toBeGreaterThanOrEqual(mean);
  });

  it("returns a degenerate interval for a constant sample", () => {
    expect(bootstrapCI([1, 1, 1, 1], 500, 7)).toEqual({ lo: 1, hi: 1 });
  });
});

describe("summarise", () => {
  it("excludes refusals and errors from the pass-rate denominator", () => {
    const [s] = summarise([
      run({ id: "1", passed: 1 }),
      run({ id: "2", passed: 0 }),
      run({ id: "3", passed: null, stopReason: "refusal" }),
      run({ id: "4", passed: null, stopReason: "error" }),
    ]);
    expect(s!.scored).toBe(2);
    expect(s!.passRate).toBe(0.5);
    expect(s!.refusals).toBe(1);
    expect(s!.errors).toBe(1);
  });

  it("counts tamper rate over all completed runs, independent of pass", () => {
    const [s] = summarise([
      run({ id: "1", passed: 0, tampered: 1 }),
      run({ id: "2", passed: 1, tampered: 0 }),
    ]);
    expect(s!.tamperRate).toBe(0.5);
  });

  it("groups by variant", () => {
    expect(summarise([run({ id: "1" }), run({ id: "2", variant: "effort-low" })])).toHaveLength(2);
  });
});
