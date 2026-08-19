import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapCI, buildReport, median, summarise } from "./report.js";
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

  it("keeps raw step counts, which a mean cannot be un-averaged into", () => {
    const [s] = summarise([run({ id: "1", steps: 3 }), run({ id: "2", steps: 11 })]);
    expect(s!.stepValues).toEqual([3, 11]);
    expect(s!.meanSteps).toBe(7);
    expect(median(s!.stepValues)).toBe(7);
  });
});

describe("median", () => {
  it("averages the middle pair on an even sample", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([4, 1, 3])).toBe(3);
    expect(median([])).toBe(0);
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
      const html = fs.readFileSync(out, "utf8");
      expect(html).toContain("1 runs across 1 variants");
      // Every view TSD 14 promises, checked by heading rather than by eyeballing a
      // rendered page: the report shipped with one of the seven for a long time.
      for (const heading of [
        "Pass rate and tamper rate by variant",
        "Cost against pass rate",
        "Reasoning tokens against pass rate",
        "Step count distribution",
        "Outcome mix",
        "Trajectory drill-down",
      ]) expect(html, `missing chart: ${heading}`).toContain(heading);
      // The drill-down is per run, and it is the trajectory that makes an aggregate
      // checkable rather than something to be taken on trust.
      expect(html).toContain("<details>");
      expect(html).toContain("seq");
      // A tracked artifact has to be committable: 65 lines of this file used to fail
      // `git diff --check`, because an interpolation that renders to nothing leaves a
      // line of pure indentation behind.
      expect(html.split(/\r?\n/).filter(l => /[ \t]$/.test(l))).toEqual([]);
      // Same reason, other half: three optional blocks in a row left three blank
      // lines in every run's drill-down.
      expect(html).not.toMatch(/\n\n\n/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // The published sweep databases are tracked evidence, and `npm run report` is the
  // command most likely to be pointed at one. A normal open would write to it — the
  // journal-mode header, plus any table the schema has gained since it was written —
  // so buildReport opens read-only, and this checksums a real tracked database across
  // a full report build to prove it.
  it("does not modify the database it reports on", () => {
    const dir = makeSandbox("aeh-report-ro-");
    try {
      const db = path.join(HARNESS_ROOT, "eval-budget-smoke.db");
      const before = fs.readFileSync(db);
      const out = path.join(dir, "evidence.html");
      buildReport(db, out);
      expect(fs.readFileSync(out, "utf8")).toContain("1 runs across 1 variants");
      expect(fs.readFileSync(db).equals(before)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Three published trajectories hold two executions of the same cell. The drill-down
  // is exactly where that would mislead — an interleaved stream reads as one run — so
  // it is marked, and this drives the real database rather than a constructed one
  // (the UNIQUE index means a commingled stream can no longer be created through the
  // store API at all).
  it("marks a commingled trajectory in the drill-down", () => {
    const dir = makeSandbox("aeh-report-cm-");
    try {
      const out = path.join(dir, "judge.html");
      buildReport(path.join(HARNESS_ROOT, "eval-judge.db"), out);
      const html = fs.readFileSync(out, "utf8");
      expect(html).toContain("COMMINGLED");
      expect(html).toContain("Two executions are stored under this run id");
      // Exactly the three known runs, and no others.
      expect(html.split("COMMINGLED").length - 1).toBe(3);
      for (const id of ["905-underivable-initials:nano:0", "905-underivable-initials:nano:1",
                        "905-underivable-initials:nano:2"]) {
        expect(html).toContain(id);
      }
      // And a clean run in the same report is not marked: the three above are the
      // only <summary> lines carrying the warning.
      const marked = html.split(/\r?\n/).filter(l => l.includes("COMMINGLED"));
      expect(marked).toHaveLength(3);
      expect(marked.every(l => l.includes("905-underivable-initials"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses a database that does not exist instead of reporting zero runs", () => {
    expect(() => buildReport(path.join(HARNESS_ROOT, "no-such-sweep.db"), "unused.html"))
      .toThrow(/no such database/);
  });
});
