import { describe, expect, it, vi } from "vitest";
import { assertPrefixLongEnough, pool, requireKey } from "./runner.js";
import { zeroUsage } from "./cost.js";

describe("assertPrefixLongEnough", () => {
  it("throws when the cacheable prefix is under the 1024-token floor", () => {
    expect(() => assertPrefixLongEnough("baseline", { ...zeroUsage(), inputTokens: 800 }))
      .toThrow(/below the 1024/);
  });

  it("sums all three prompt categories, not just uncached input", () => {
    expect(() => assertPrefixLongEnough("baseline", {
      ...zeroUsage(), inputTokens: 100, cacheWriteTokens: 1200,
    })).not.toThrow();
  });
});

describe("requireKey", () => {
  it("names the missing variable", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => requireKey("anthropic")).toThrow(/ANTHROPIC_API_KEY/);
    vi.unstubAllEnvs();
  });
});

describe("pool", () => {
  it("never exceeds the concurrency limit", async () => {
    let active = 0, peak = 0;
    await pool([...Array(20).keys()], 4, async () => {
      peak = Math.max(peak, ++active);
      await new Promise(r => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("processes every item", async () => {
    const seen: number[] = [];
    await pool([...Array(20).keys()], 4, async (i) => { seen.push(i); });
    expect(seen.sort((a, b) => a - b)).toEqual([...Array(20).keys()]);
  });
});
