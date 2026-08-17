import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertFixtureIntact, assertPrefixLongEnough, cacheFloor, CACHE_MIN_EVIDENCE, CACHE_WINDOW,
  cacheVerdict, pool, prewarmWithRetry, requireKey,
} from "./runner.js";
import { zeroUsage } from "./cost.js";
import { PROVIDERS } from "./provider/index.js";
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

  it("distinguishes a zero-usage pre-warm from a merely short prompt", () => {
    // Observed live: a pre-warm returned all-zero usage while the identical request
    // retried reported 1285 prompt tokens. The old message told the operator to
    // lengthen SYSTEM_PROMPT, which is the wrong bug and unfixable advice.
    expect(() => assertPrefixLongEnough("nano", zeroUsage()))
      .toThrow(/NO prompt tokens at all/);
    expect(() => assertPrefixLongEnough("nano", zeroUsage()))
      .toThrow(/do NOT lengthen SYSTEM_PROMPT/);
    // A genuinely short prompt still gets the lengthen-the-prompt advice.
    expect(() => assertPrefixLongEnough("nano", { ...zeroUsage(), inputTokens: 800 }))
      .toThrow(/Lengthen SYSTEM_PROMPT/);
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

describe("prewarmWithRetry", () => {
  const cfg = { model: "gpt-5-nano", effort: "low", systemPrompt: "s", tools: [],
                maxTokensPerTurn: 16000, cacheKey: "k" } as never;
  const noSleep = async () => {};

  it("retries a zero-usage pre-warm and returns the first real reading", async () => {
    // The live failure: two sweeps died at startup because a cold cache key's first
    // pre-warm reported nothing, while the identical request retried reported 1285.
    const readings = [zeroUsage(), zeroUsage(), { ...zeroUsage(), inputTokens: 1285 }];
    let calls = 0;
    const provider = { prewarm: async () => readings[calls++]! };
    const warned = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const warm = await prewarmWithRetry("nano", provider, cfg, 3, noSleep);
      expect(warm.inputTokens).toBe(1285);
      expect(calls).toBe(3);
      expect(warned).toHaveBeenCalledTimes(2);
    } finally { warned.mockRestore(); }
  });

  it("does NOT retry a prefix that is merely short — that is a real failure", async () => {
    let calls = 0;
    const provider = { prewarm: async () => { calls++; return { ...zeroUsage(), inputTokens: 800 }; } };
    const warm = await prewarmWithRetry("nano", provider, cfg, 3, noSleep);
    expect(calls).toBe(1);
    // Falls through to the floor check, which is the correct diagnosis for 800 tokens.
    expect(() => assertPrefixLongEnough("nano", warm)).toThrow(/Lengthen SYSTEM_PROMPT/);
  });

  it("gives up after the attempt cap and lets the real diagnosis through", async () => {
    let calls = 0;
    const provider = { prewarm: async () => { calls++; return zeroUsage(); } };
    const warned = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const warm = await prewarmWithRetry("nano", provider, cfg, 3, noSleep);
      expect(calls).toBe(3);
      expect(() => assertPrefixLongEnough("nano", warm)).toThrow(/NO prompt tokens at all/);
    } finally { warned.mockRestore(); }
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

describe("cacheVerdict", () => {
  it("aborts an explicit vendor on the very first completed run that read nothing", () => {
    const v = cacheVerdict("explicit", 1, 0);
    expect(v).toMatch(/prompt caching is not working/);
    // The message has to carry the evidence, not just the accusation.
    expect(v).toMatch(/1 completed run\(s\).*explicit.*0 cached tokens.*1-run window/s);
  });

  it("says nothing about an explicit vendor that read the cache", () => {
    expect(cacheVerdict("explicit", 1, 4096)).toBeNull();
  });

  it("does NOT abort an implicit vendor before the window closes", () => {
    // The bug this exists to fix: Gemini legitimately reports 0 on any single
    // run, so a sweep must survive a run of misses short of the whole window.
    for (let runs = 1; runs < CACHE_WINDOW.implicit; runs++) {
      expect(cacheVerdict("implicit", runs, 0)).toBeNull();
    }
  });

  it("aborts an implicit vendor once a whole window read nothing", () => {
    const v = cacheVerdict("implicit", CACHE_WINDOW.implicit, 0);
    expect(v).toMatch(/8 completed run\(s\).*implicit.*8-run window/s);
    // Actionable, and honest about what implicit caching does and does not promise.
    expect(v).toMatch(/best-effort/);
  });

  it("says nothing when a full implicit window read the cache even once", () => {
    expect(cacheVerdict("implicit", CACHE_WINDOW.implicit, 782)).toBeNull();
  });

  it("judges a sweep shorter than the window at its own end, not never", () => {
    // 5 cells: the runner caps the window at the cell count, so all-zero is
    // conclusive at run 5 — but not at run 4, and not under the default window.
    expect(cacheVerdict("implicit", 4, 0, 5)).toBeNull();
    expect(cacheVerdict("implicit", 5, 0, 5)).toMatch(/5 completed run\(s\).*5-run window/s);
    expect(cacheVerdict("implicit", 5, 0)).toBeNull();
  });

  it("refuses to convict an implicit vendor on fewer than CACHE_MIN_EVIDENCE runs", () => {
    // The G4 bug: `--tasks 001-off-by-one --reps 1` gives a 1-cell sweep, the
    // runner caps the window at 1, and the gate collapsed back to the single-run
    // assert that windowing existed to remove — aborting the cheapest pre-flight
    // command the plan prescribes. One sample cannot tell a broken cache from
    // Gemini's ~2-in-3 miss rate, so it must warn and carry on.
    const warned = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let runs = 1; runs < CACHE_MIN_EVIDENCE; runs++) {
        warned.mockClear();
        // window === runs: the capped window has closed, which is exactly when
        // the old code aborted.
        expect(cacheVerdict("implicit", runs, 0, runs)).toBeNull();
        expect(warned).toHaveBeenCalledTimes(1);
        expect(warned.mock.calls[0]![0]).toMatch(/INSUFFICIENT EVIDENCE/);
        expect(warned.mock.calls[0]![0]).toContain(`${runs} completed run(s)`);
        // A warning, not an accusation: it must not read as the abort message.
        expect(warned.mock.calls[0]![0]).not.toMatch(/Aborting/);
      }
    } finally {
      warned.mockRestore();
    }
  });

  it("becomes conclusive for an implicit vendor at exactly CACHE_MIN_EVIDENCE runs", () => {
    const warned = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const v = cacheVerdict("implicit", CACHE_MIN_EVIDENCE, 0, CACHE_MIN_EVIDENCE);
      expect(v).toMatch(/prompt caching is not working/);
      expect(v).toMatch(/4 completed run\(s\).*implicit.*4-run window/s);
      expect(warned).not.toHaveBeenCalled();   // conclusive, so no hedged warning
      // Still nothing to say when the cache was read.
      expect(cacheVerdict("implicit", CACHE_MIN_EVIDENCE, 782, CACHE_MIN_EVIDENCE)).toBeNull();
    } finally {
      warned.mockRestore();
    }
  });

  it("leaves the explicit path completely untouched by the evidence floor", () => {
    const warned = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // One completed run, zero reads, one-run window: still an immediate abort,
      // with no warning and no waiting for a fourth run.
      for (let runs = 1; runs < CACHE_MIN_EVIDENCE; runs++) {
        expect(cacheVerdict("explicit", runs, 0)).toMatch(/prompt caching is not working/);
      }
      expect(warned).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });
});

describe("PROVIDERS", () => {
  it("every provider declares a cacheMode, so a fourth adapter cannot forget it", () => {
    for (const [id, p] of Object.entries(PROVIDERS)) {
      expect(CACHE_WINDOW[p.cacheMode], `${id} declares an unknown cacheMode`).toBeGreaterThan(0);
    }
    // The vendor difference the gate exists for — asserted, not assumed.
    expect(PROVIDERS.google.cacheMode).toBe("implicit");
    expect(PROVIDERS.openai.cacheMode).toBe("explicit");
    expect(PROVIDERS.anthropic.cacheMode).toBe("explicit");
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
