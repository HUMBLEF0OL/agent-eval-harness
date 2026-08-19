import { describe, expect, it } from "vitest";
import { binomialTailAtLeast, compare, perFixtureMeans, signTest } from "./stats.js";
import type { RunRow } from "./store.js";

const run = (over: Partial<RunRow>): RunRow => ({
  id: "x", taskId: "t", variant: "nano", provider: "openai", model: "gpt-5-nano",
  effort: "high", rep: 0, startedAt: "", endedAt: null, stopReason: "end_turn", steps: 5,
  passed: 1, tampered: 0, tamperDetail: null, sourceCheat: null, sourceCheatKind: null,
  sourceCheatEvidence: null, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
  outputTokens: 0, reasoningTokens: 1000, costUsd: 0.001, wallMs: 0, error: null, ...over,
});

describe("binomialTailAtLeast", () => {
  it("is exact at the edges", () => {
    expect(binomialTailAtLeast(0, 8)).toBe(1);
    expect(binomialTailAtLeast(8, 8)).toBeCloseTo(1 / 256, 12);
    expect(binomialTailAtLeast(9, 8)).toBe(0);
  });

  it("halves at the median of an odd n", () => {
    expect(binomialTailAtLeast(1, 1)).toBeCloseTo(0.5, 12);
    expect(binomialTailAtLeast(8, 15)).toBeCloseTo(0.5, 12);
  });

  it("refuses an n it cannot compute exactly rather than approximating silently", () => {
    expect(() => binomialTailAtLeast(600, 1001)).toThrow(/overflows the exact tail/);
  });
});

// These three are the p-values the README publishes. Pinning them here is the point of
// the file: they used to be computed by hand off-tree, which is the same defect as an
// un-tracked database — a number nobody can recompute from the repository.
describe("the published p-values", () => {
  it("reproduces 8 of 8 paired fixtures at one-sided p = 0.0039", () => {
    const t = signTest(8, 0);
    expect(t.oneSided).toBeCloseTo(0.0039, 4);
    expect(t.twoSided).toBeCloseTo(0.0078, 4);
  });

  it("reproduces 10 of 15 at one-sided p = 0.15 — the split that was NOT a finding", () => {
    const t = signTest(10, 5);
    expect(t.oneSided).toBeCloseTo(0.1509, 4);
    expect(t.twoSided).toBeCloseTo(0.3018, 4);
  });

  it("reproduces one discordant pair at exactly p = 1.000", () => {
    const t = signTest(1, 0, 7);
    expect(t.twoSided).toBe(1);
    expect(t.ties).toBe(7);
  });
});

describe("perFixtureMeans", () => {
  it("collapses reps into one value per fixture, so n stays the fixture count", () => {
    const means = perFixtureMeans([
      run({ taskId: "a", rep: 0, reasoningTokens: 1000 }),
      run({ taskId: "a", rep: 1, reasoningTokens: 2000 }),
      run({ taskId: "b", rep: 0, reasoningTokens: 500 }),
    ], "reasoningTokens");
    expect(means.get("nano")!.get("a")).toBe(1500);
    expect(means.get("nano")!.get("b")).toBe(500);
  });

  it("ignores unscorable runs when the metric is pass", () => {
    const means = perFixtureMeans([
      run({ taskId: "a", passed: 1 }),
      run({ taskId: "a", passed: null, stopReason: "error" }),
    ], "passed");
    expect(means.get("nano")!.get("a")).toBe(1);   // not 0.5
  });
});

describe("compare", () => {
  it("pairs only fixtures both arms ran", () => {
    const c = compare([
      run({ variant: "nano", taskId: "a", costUsd: 0.002 }),
      run({ variant: "low", taskId: "a", costUsd: 0.001 }),
      run({ variant: "nano", taskId: "only-nano", costUsd: 0.009 }),
    ], "costUsd", "nano", "low");
    expect(c.pairs).toBe(1);
    expect(c.meanDelta).toBeCloseTo(0.001, 9);
    expect(c.test.higher).toBe(1);
  });

  it("counts a tie as a tie and leaves it out of the test", () => {
    const c = compare([
      run({ variant: "nano", taskId: "a", passed: 1 }),
      run({ variant: "low", taskId: "a", passed: 1 }),
      run({ variant: "nano", taskId: "b", passed: 1 }),
      run({ variant: "low", taskId: "b", passed: 0 }),
    ], "passed", "nano", "low");
    expect(c.test).toMatchObject({ higher: 1, lower: 0, ties: 1 });
    expect(c.test.twoSided).toBe(1);          // one discordant pair says nothing
  });

  it("does not call a floating-point crumb a win", () => {
    const c = compare([
      run({ variant: "nano", taskId: "a", costUsd: 0.1 + 0.2 }),
      run({ variant: "low", taskId: "a", costUsd: 0.30000000000000004 }),
    ], "costUsd", "nano", "low");
    expect(c.test.ties).toBe(1);
    expect(c.test.higher + c.test.lower).toBe(0);
  });
});
