import { pathToFileURL } from "node:url";
import { bootstrapCI } from "./report.js";
import { openStore, type RunRow } from "./store.js";

/**
 * Paired statistics over a sweep database.
 *
 * Every comparison this harness publishes is PAIRED BY FIXTURE, and that is the only
 * design that makes n=8 or n=15 worth reporting at all: the fixtures differ from each
 * other far more than the arms differ from each other, so an unpaired test spends all
 * its power on between-fixture variance. The README quotes three p-values from this
 * shape (8/8 at 0.0039, 10/15 at 0.15, one discordant pair at 1.000); before this file
 * they were computed by hand, off-tree, and unreproducible from the repository — the
 * same defect as the un-tracked databases, one level up.
 */

/** Exact binomial tail P(X >= k) for n trials at p = 0.5, in integers.
 *  BigInt rather than a normal approximation: n is 8-23 here, which is exactly the
 *  range where the approximation is worst and where a wrong p-value would be believed. */
export function binomialTailAtLeast(k: number, n: number): number {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 0 || k < 0) {
    throw new Error(`binomialTailAtLeast needs non-negative integers, got k=${k}, n=${n}`);
  }
  if (n > 1000) throw new Error(`n=${n} overflows the exact tail; use a normal approximation`);
  if (k > n) return 0;
  let sum = 0n;
  let c = 1n;                                   // C(n, 0)
  for (let i = 0; i <= n; i++) {
    if (i >= k) sum += c;
    c = (c * BigInt(n - i)) / BigInt(i + 1);     // exact: C(n,i+1) from C(n,i)
  }
  return Number(sum) / Number(2n ** BigInt(n));
}

export interface SignTest {
  /** Pairs where A's value was HIGHER than B's, where it was lower, and where they
   *  tied. Deliberately not a direction word: higher is better for `passed` and worse
   *  for cost, reasoning and steps, so "better" here would misread three metrics out
   *  of four. Ties are EXCLUDED from the test, which is what the "n discordant pairs"
   *  language means. */
  higher: number; lower: number; ties: number;
  /** P(at least this many on the majority side) under the null that either direction
   *  likely — the direction the effect actually went, not a direction chosen first. */
  oneSided: number;
  /** Two-sided, capped at 1. Report this unless a direction was predicted in advance. */
  twoSided: number;
}

export function signTest(higher: number, lower: number, ties = 0): SignTest {
  const n = higher + lower;
  const oneSided = n === 0 ? 1 : binomialTailAtLeast(Math.max(higher, lower), n);
  return { higher, lower, ties, oneSided, twoSided: Math.min(1, 2 * oneSided) };
}

export type Metric = "passed" | "reasoningTokens" | "costUsd" | "steps";

/** Mean of a metric per (variant, task): reps collapse into one number per fixture, so
 *  each fixture contributes exactly one pair however many times it was run. Running a
 *  cell more often must buy a better ESTIMATE, not a bigger n. */
export function perFixtureMeans(runs: RunRow[], metric: Metric): Map<string, Map<string, number>> {
  const acc = new Map<string, Map<string, { sum: number; n: number }>>();
  for (const r of runs) {
    const value = metric === "passed" ? r.passed : r[metric];
    if (value === null || value === undefined) continue;      // unscorable runs contribute nothing
    const byTask = acc.get(r.variant) ?? new Map();
    const cell = byTask.get(r.taskId) ?? { sum: 0, n: 0 };
    cell.sum += value; cell.n += 1;
    byTask.set(r.taskId, cell);
    acc.set(r.variant, byTask);
  }
  const out = new Map<string, Map<string, number>>();
  for (const [variant, byTask] of acc) {
    out.set(variant, new Map([...byTask].map(([task, c]) => [task, c.sum / c.n])));
  }
  return out;
}

export interface Comparison {
  metric: Metric; a: string; b: string;
  /** Fixtures present in BOTH arms. A fixture only one arm ran is not a pair. */
  pairs: number;
  meanDelta: number;                     // mean(a) - mean(b) across paired fixtures
  deltaCI: { lo: number; hi: number };   // bootstrap 95% CI of that mean delta
  test: SignTest;
}

/** `epsilon` is what stops floating-point noise from being counted as a win: two
 *  reasoning-token means that differ by 1e-13 tied, they did not differ. */
export function compare(
  runs: RunRow[], metric: Metric, a: string, b: string, epsilon = 1e-9,
): Comparison {
  const means = perFixtureMeans(runs, metric);
  const A = means.get(a) ?? new Map(), B = means.get(b) ?? new Map();
  const tasks = [...A.keys()].filter(t => B.has(t)).sort();
  const deltas = tasks.map(t => A.get(t)! - B.get(t)!);
  let higher = 0, lower = 0, ties = 0;
  for (const d of deltas) {
    if (Math.abs(d) <= epsilon) ties++;
    else if (d > 0) higher++;
    else lower++;
  }
  return {
    metric, a, b, pairs: tasks.length,
    meanDelta: deltas.length ? deltas.reduce((x, y) => x + y, 0) / deltas.length : 0,
    deltaCI: bootstrapCI(deltas),
    test: signTest(higher, lower, ties),
  };
}

/** Every ordered-once pair of variants in the database, on every metric. Reading the
 *  whole matrix at once is deliberate: picking the comparison after seeing the data is
 *  how a 10/15 split becomes a headline. */
export function compareAll(runs: RunRow[]): Comparison[] {
  const variants = [...new Set(runs.map(r => r.variant))].sort();
  const metrics: Metric[] = ["passed", "reasoningTokens", "costUsd", "steps"];
  const out: Comparison[] = [];
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      for (const m of metrics) out.push(compare(runs, m, variants[i]!, variants[j]!));
    }
  }
  return out;
}

const fmt = (n: number) => Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(5);

export function formatComparison(c: Comparison): string {
  const { higher, lower, ties, oneSided, twoSided } = c.test;
  const verdict = twoSided < 0.05 ? "SIGNIFICANT" : "not significant";
  return `  ${c.metric.padEnd(16)} ${c.a} vs ${c.b}\n` +
    `      pairs=${c.pairs}  ${c.a} higher on ${higher}, lower on ${lower}, tied on ${ties}\n` +
    `      mean delta (${c.a} - ${c.b}) ${fmt(c.meanDelta)}  95% CI [${fmt(c.deltaCI.lo)}, ${fmt(c.deltaCI.hi)}]\n` +
    `      sign test: one-sided p=${oneSided.toFixed(4)}  two-sided p=${twoSided.toFixed(4)}  -> ${verdict}`;
}

/** Runs from several databases, for a comparison that spans tiers. Legitimate because
 *  the unit of pairing is the FIXTURE and no fixture appears in two tiers — so pooling
 *  adds independent pairs rather than re-counting the same ones. It is also the only
 *  honest way to report a direction that is significant in one tier and merely
 *  consistent in another: 15 of 15 and 7 of 8 are one 22-of-23 observation. */
export function pooledReport(dbPaths: string[]): string {
  const runs: RunRow[] = [];
  const tasks = new Map<string, string>();
  for (const p of dbPaths) {
    const store = openStore(p, { readonly: true });
    try {
      for (const r of store.allRuns()) {
        const seen = tasks.get(r.taskId);
        if (seen && seen !== p) {
          throw new Error(`fixture ${r.taskId} appears in both ${seen} and ${p}: pooling would ` +
            `count one fixture as two independent pairs`);
        }
        tasks.set(r.taskId, p);
        runs.push(r);
      }
    } finally { store.close(); }
  }
  const lines = [
    `POOLED across ${dbPaths.length} databases: ${runs.length} runs, ${tasks.size} fixtures`,
    `Each fixture contributes one pair, whichever database it came from.`,
    "",
  ];
  for (const c of compareAll(runs)) lines.push(formatComparison(c), "");
  return lines.join("\n");
}

export function report(dbPath: string): string {
  // Read-only, like every other reader of a sweep database (see store.ts).
  const store = openStore(dbPath, { readonly: true });
  try {
    const runs = store.allRuns();
    const scored = runs.filter(r => r.passed !== null).length;
    const lines = [
      `${dbPath}: ${runs.length} runs, ${scored} scored, ` +
      `${new Set(runs.map(r => r.taskId)).size} fixtures, ` +
      `${new Set(runs.map(r => r.variant)).size} variants`,
      `Paired by fixture; reps collapse to one mean per fixture, so n is the number of`,
      `fixtures, never the number of runs. Ties are excluded from the sign test.`,
      "",
    ];
    for (const c of compareAll(runs)) lines.push(formatComparison(c), "");
    return lines.join("\n");
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const pool = args[0] === "--pool";
  const dbs = pool ? args.slice(1) : args;
  if (dbs.length === 0) {
    console.error("usage: tsx src/stats.ts [--pool] <db> [db...]");
    process.exitCode = 2;
  } else if (pool) {
    console.log(pooledReport(dbs));
  } else {
    for (const db of dbs) console.log(report(db));
  }
}
