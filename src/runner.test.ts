import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertFixtureIntact, assertPrefixLongEnough, cacheFloor, pool, requireKey } from "./runner.js";
import { zeroUsage } from "./cost.js";
import { makeSandbox } from "./sandbox.js";
import { hashGuardedFiles } from "./score/tamper.js";

describe("assertPrefixLongEnough", () => {
  it("throws when the cacheable prefix is under the default 1100-token floor", () => {
    expect(() => assertPrefixLongEnough("baseline", { ...zeroUsage(), inputTokens: 800 }))
      .toThrow(/below this variant's 1100-token floor/);
  });

  it("sums all three prompt categories, not just uncached input", () => {
    // 400 + 300 + 500 = 1200, over the floor, but no single category is — so this
    // passes only if all three are summed.
    const spread = { ...zeroUsage(), inputTokens: 400, cacheWriteTokens: 300, cacheReadTokens: 500 };
    expect(() => assertPrefixLongEnough("baseline", spread)).not.toThrow();
    for (const k of ["inputTokens", "cacheWriteTokens", "cacheReadTokens"] as const) {
      expect(() => assertPrefixLongEnough("baseline", { ...zeroUsage(), [k]: spread[k] }))
        .toThrow(/below this variant's 1100-token floor/);
    }
  });

  it("honours a higher per-variant floor and names the floor it missed", () => {
    // 1200 clears the default floor but not Gemini 2.5 Pro's 2048 + margin, which
    // is the whole reason the floor is no longer one hardcoded number.
    const warm = { ...zeroUsage(), inputTokens: 1200 };
    expect(() => assertPrefixLongEnough("gemini-pro", warm)).not.toThrow();
    expect(() => assertPrefixLongEnough("gemini-pro", warm, 2124))
      .toThrow(/1200 tokens, below this variant's 2124-token floor/);
  });
});

describe("cacheFloor", () => {
  it("defaults to 1024 plus margin", () => {
    expect(cacheFloor({ model: "gpt-5.6-terra" })).toBe(1100);
    expect(cacheFloor({ model: "gemini-2.5-flash" })).toBe(1100);
    expect(cacheFloor({ model: "gemini-3.5-flash-lite" })).toBe(1100);
  });

  it("raises the floor for models whose caching minimum is higher", () => {
    expect(cacheFloor({ model: "gemini-2.5-pro" })).toBe(2124);
    expect(cacheFloor({ model: "claude-haiku-4-5" })).toBe(4172);
  });
});

describe("assertFixtureIntact", () => {
  it("passes on an untouched fixture and names the file when the restore source is poisoned", () => {
    const dir = makeSandbox("aeh-fixint-");
    try {
      const testFile = path.join(dir, "src", "sum.test.ts");
      fs.mkdirSync(path.dirname(testFile), { recursive: true });
      fs.writeFileSync(testFile, "expect(sum([1,2])).toBe(3)");
      const baseline = hashGuardedFiles(dir);

      expect(() => assertFixtureIntact("001-off-by-one", dir, baseline)).not.toThrow();

      fs.writeFileSync(testFile, "expect(true).toBe(true)");
      expect(() => assertFixtureIntact("001-off-by-one", dir, baseline))
        .toThrow(/001-off-by-one.*src\/sum\.test\.ts/s);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("requireKey", () => {
  it("names the missing variable", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => requireKey("anthropic")).toThrow(/ANTHROPIC_API_KEY/);
    vi.unstubAllEnvs();
  });

  it("asks google for GEMINI_API_KEY, not for the wrong vendor's key", () => {
    // The ternary this replaced would have demanded ANTHROPIC_API_KEY here.
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "set-but-irrelevant");
    expect(() => requireKey("google")).toThrow(/GEMINI_API_KEY/);
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
