import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapCI, summarise } from "./report.js";
import { HARNESS_ROOT, makeSandbox } from "./sandbox.js";
import { openStore, type RunRow } from "./store.js";

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

// The unit tests above import buildReport's helpers directly, which is exactly
// how a broken main-module guard stayed invisible: `npm run report` exited 0 and
// wrote nothing. This drives the documented CLI instead.
describe("report entrypoint", () => {
  it("writes the file when run as `tsx src/report.ts <db> <out>`", () => {
    const dir = makeSandbox("aeh-report-");
    try {
      const db = path.join(dir, "probe.db");
      const out = path.join(dir, "report.html");
      const store = openStore(db);
      store.upsertRun(run({ id: "1" }));
      store.close();

      // No `npx`, no shell, no hand-quoted arguments. `npx` is a .cmd on Windows and
      // needs a shell to resolve, but a shell means the arguments get re-parsed by
      // cmd.exe or /bin/sh — so the paths had to be wrapped in quotes that each shell
      // then strips differently. Running tsx's own CLI entry through process.execPath
      // (the same trick src/sandbox.ts uses for vitest) removes the shell from the
      // picture entirely: argv is passed as an array, so a path containing a space
      // needs no quoting and behaves identically on Windows, Linux and macOS. It also
      // silences the last DEP0190 warning in the suite.
      const TSX_CLI = path.join(HARNESS_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
      const res = spawnSync(process.execPath, [TSX_CLI, "src/report.ts", db, out],
        { cwd: HARNESS_ROOT, encoding: "utf8" });

      expect(res.status, res.stderr).toBe(0);
      expect(fs.existsSync(out), `no file written; stdout: ${res.stdout}`).toBe(true);
      expect(fs.readFileSync(out, "utf8")).toContain("1 runs across 1 variants");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
