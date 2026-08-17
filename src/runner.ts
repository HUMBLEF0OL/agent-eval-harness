import * as fs from "node:fs";
import * as path from "node:path";
import { costUsd, promptTokens, zeroUsage } from "./cost.js";
import { runLoop, type LoopConfig } from "./loop.js";
import { PROVIDERS } from "./provider/index.js";
import { makeSandbox } from "./sandbox.js";
import { judgeSourceCheat } from "./score/judge.js";
import { diffHashes, hashGuardedFiles } from "./score/tamper.js";
import { scoreTests } from "./score/tests.js";
import { openStore, type RunRow } from "./store.js";
import { makeTools } from "./tools.js";
import { VARIANTS, type Variant } from "./variants.js";
import { JUDGE_MODEL } from "./types.js";
import type { CacheMode, EventInput, ProviderId, SessionConfig, UsageTotals } from "./types.js";

export interface SweepOptions {
  variants: string[];
  reps: number;
  tasks?: string[];
  concurrency: number;
  keepTemp: boolean;
  db: string;
  maxSteps: number;
  /** Opt-in stretch (TSD §9.3): runs the LLM cheat judge over the source-side
   *  diff. Off by default — it is an extra billed call on every run and
   *  cannot be exercised without a key. */
  judge: boolean;
}

// JUDGE_MODEL lives in ./types.js: the report needs it too, and importing it
// from here would drag the provider registry — and both vendor SDKs — into the
// report path. The "nano" variant is unrun by design (PRD §5.4), so the guard
// in runSweep below never actually fires; it exists to fail loudly if that ever
// changes rather than silently judging a model against itself.

/** A lookup, not a ternary. The old `p === "openai" ? OPENAI : ANTHROPIC` shape
 *  asked for the WRONG variable the moment a third provider existed, and it did
 *  so silently — the sweep would refuse to start naming a key you do not need.
 *  `Record<ProviderId, string>` makes a fourth provider a compile error instead. */
const KEY_ENV: Record<ProviderId, string> = {
  openai:    "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google:    "GEMINI_API_KEY",
};

export function requireKey(p: ProviderId): void {
  const k = KEY_ENV[p];
  if (!process.env[k]) throw new Error(`${k} is not set, required by a selected variant`);
}

/** Smallest prefix a vendor will cache at all. Per-MODEL, which is why the floor
 *  is no longer one hardcoded number: 1024 on OpenAI and Gemini 2.5 Flash, 2048
 *  on Gemini 2.5 Pro, and on Anthropic 512 (Opus 5) / 1024 (Sonnet 5) / 4096
 *  (Haiku 4.5). Keyed on the model prefix alone because model names are already
 *  vendor-unique; anything unlisted gets the 1024 default. */
const CACHE_MINIMUM: Array<[string, number]> = [
  ["gemini-2.5-pro",   2048],
  ["claude-haiku-4-5", 4096],
];

/** Both vendors document the threshold as the point caching *starts* working and
 *  OpenAI's as inconsistent just above it, so the floor carries margin. */
const MARGIN = 76;

export function cacheFloor(v: Pick<Variant, "model">): number {
  return (CACHE_MINIMUM.find(([m]) => v.model.startsWith(m))?.[1] ?? 1024) + MARGIN;
}

/** Every vendor fails silently when the prefix is too short. This is the check
 *  that turns a silent 5x cost error into a startup failure (TSD §6.4). */
export function assertPrefixLongEnough(name: string, warm: UsageTotals, floor = 1024 + MARGIN): void {
  const prefix = promptTokens(warm);
  // A zero is NOT a short prompt — it means the pre-warm response carried no usable
  // usage at all, which no amount of lengthening SYSTEM_PROMPT can fix. Observed live:
  // a pre-warm returned all-zero usage while the very same request, retried, reported
  // 1285 prompt tokens. Telling the operator to lengthen a 1285-token prompt sent them
  // after the wrong bug, so the two cases must not share one message.
  if (prefix === 0) {
    throw new Error(
      `variant ${name}: the pre-warm response carried NO prompt tokens at all ` +
      `(${JSON.stringify(warm)}). This is a vendor/transport problem, not a short prompt — ` +
      `do NOT lengthen SYSTEM_PROMPT. Retry; if it persists, log the raw pre-warm response.`,
    );
  }
  if (prefix < floor) {
    throw new Error(
      `variant ${name}: cacheable prefix is ${prefix} tokens, below this variant's ${floor}-token ` +
      `floor (the model's caching minimum, with margin). Caching would silently do nothing. ` +
      `Lengthen SYSTEM_PROMPT with useful tool-use guidance — not filler.`,
    );
  }
}

/** How many completed runs of evidence the cache gate needs before a zero means
 *  anything. Explicit vendors set a cache key or breakpoint and a warm prefix
 *  reads reliably, so one run is already proof. Implicit caching (Gemini 2.5+)
 *  is best-effort with no control surface: measured on gemini-2.5-flash, two of
 *  three recorded sessions read nothing while the third read the full prefix, so
 *  a single zero says nothing and a per-run assert would abort a healthy sweep. */
export const CACHE_WINDOW: Record<CacheMode, number> = { explicit: 1, implicit: 8 };

/** Returns an abort message when the evidence is conclusive, else null.
 *  Explicit: one completed run with no cache read is already conclusive.
 *  Implicit: only a whole window of completed runs with ZERO cache reads in
 *  aggregate is conclusive — one miss is normal and must not abort a sweep.
 *  `window` is passed in so a variant with fewer cells than the window is judged
 *  at its own end rather than never: a 3-run sweep that never caches must fail. */
export function cacheVerdict(
  mode: CacheMode,
  completedRuns: number,
  aggregateCacheReadTokens: number,
  window = CACHE_WINDOW[mode],
): string | null {
  if (aggregateCacheReadTokens > 0 || completedRuns < window) return null;
  return `prompt caching is not working: ${completedRuns} completed run(s) of a vendor with ` +
    `${mode} caching read ${aggregateCacheReadTokens} cached tokens in aggregate, over a ` +
    `${window}-run window. Every cost number in this sweep would be wrong. Aborting. ` +
    (mode === "explicit"
      ? `Check the cache key / breakpoints in the adapter and that the prefix is byte-stable.`
      : `Implicit caching is best-effort, so this is a whole window of misses, not variance: ` +
        `check the prefix is byte-stable and long enough for this model, and that runs are not ` +
        `spaced far enough apart for the cache to expire.`);
}

/** The fixture's `repo/` is the restore source scoreTests copies test files back
 *  from (TSD §9.1), and vitest executes model-authored code with harness
 *  privileges — so a run that writes outside its sandbox could rewrite that
 *  source and silently poison every later run of the task. Hashes are taken once
 *  at sweep start and re-checked before every scoring call; a mismatch means the
 *  reference is no longer trustworthy, so the sweep aborts rather than producing
 *  numbers scored against a corrupted baseline (TSD §4.2). */
export function assertFixtureIntact(id: string, repoDir: string, baseline: Map<string, string>): void {
  const { tampered, changed } = diffHashes(baseline, hashGuardedFiles(repoDir));
  if (tampered) {
    throw new Error(
      `fixture ${id}: guarded files under ${repoDir} changed during the sweep ` +
      `(${changed.join(", ")}). The restore source for this task is corrupted, so every ` +
      `later run scored against it would be meaningless. Aborting; restore the fixture from git.`,
    );
  }
}

export async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", ".git", "dist", "coverage"].includes(e.name)) continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      out.push(path.relative(dir, abs).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out;
}

/** Before/after content for every non-test, non-config file the agent touched
 *  (guarded files — tests, package.json, vitest config — are excluded; those
 *  are hash-tampering's job, not the judge's). Reuses hashGuardedFiles just
 *  to get the exclusion set, rather than re-implementing the guard rule. */
export function buildSourceDiff(pristineDir: string, root: string): string {
  const guarded = hashGuardedFiles(root);
  const all = new Set([...listFiles(pristineDir), ...listFiles(root)]);
  for (const rel of guarded.keys()) all.delete(rel);

  const parts: string[] = [];
  for (const rel of [...all].sort()) {
    const oldPath = path.join(pristineDir, rel);
    const newPath = path.join(root, rel);
    const oldSrc = fs.existsSync(oldPath) ? fs.readFileSync(oldPath, "utf8") : "(file did not exist)";
    const newSrc = fs.existsSync(newPath) ? fs.readFileSync(newPath, "utf8") : "(file deleted)";
    if (oldSrc === newSrc) continue;
    parts.push(`--- a/${rel}\n${oldSrc}\n+++ b/${rel}\n${newSrc}`);
  }
  return parts.join("\n\n");
}

function loadFixtures(filter?: string[]) {
  return fs.readdirSync("fixtures")
    .filter(id => !filter || filter.includes(id))
    .map(id => ({
      id,
      dir: path.join("fixtures", id),
      meta: JSON.parse(fs.readFileSync(path.join("fixtures", id, "meta.json"), "utf8")),
    }));
}

export async function runSweep(opts: SweepOptions): Promise<void> {
  const fixtures = loadFixtures(opts.tasks);
  if (fixtures.length === 0) throw new Error("no fixtures matched --tasks");
  if (opts.judge) requireKey("openai");     // the judge always calls OpenAI (JUDGE_MODEL)

  // Every reason a sweep can refuse to start is checked here, before openStore:
  // a sweep that cannot run must not leave an empty eval.db (plus its WAL files)
  // behind, and an unpriced model must fail now rather than after a paid run.
  const selected = opts.variants.map(name => {
    const variant = VARIANTS[name];
    if (!variant) throw new Error(`unknown variant: ${name}`);
    const provider = PROVIDERS[variant.provider];
    if (!provider) throw new Error(`unknown provider ${variant.provider} in variant ${name}`);
    requireKey(variant.provider);          // fail before spending an hour
    costUsd(variant.model, zeroUsage());   // throws on an unpriced model — before any spend
    if (opts.judge && variant.model === JUDGE_MODEL) {
      throw new Error(`variant ${name}: judge model ${JUDGE_MODEL} equals the model under ` +
        `test — a self-judged run is not a check. Pick a different JUDGE_MODEL.`);
    }
    return { name, variant, provider };
  });

  // Restore-source integrity baseline, taken once before anything executes.
  const pristine = new Map(fixtures.map(f =>
    [f.id, hashGuardedFiles(path.join(f.dir, "repo"))]));

  // Pre-warm every selected variant BEFORE opening the store. Pre-warm is the last
  // gate that can refuse a sweep — a revoked key, an exhausted quota, a cacheable
  // prefix under the 1024-token floor — so it belongs with the other startup checks.
  // Opening the store first meant a sweep that never ran still left an empty eval.db
  // and its WAL files on disk, which `npm run report` would happily read as 0 runs.
  const warmed = [];
  for (const { name, variant, provider } of selected) {
    const cfg: LoopConfig = {
      model: variant.model, effort: variant.effort, systemPrompt: variant.systemPrompt,
      tools: variant.tools, maxTokensPerTurn: 16000, cacheKey: name, maxSteps: opts.maxSteps,
    };
    console.log(`[${name}] pre-warming cache…`);
    assertPrefixLongEnough(name, await provider.prewarm(cfg), cacheFloor(variant));   // strictly before fan-out
    warmed.push({ name, variant, provider, cfg });
  }

  const store = openStore(opts.db);

  try {
    for (const { name, variant, provider, cfg } of warmed) {
      const cells = fixtures.flatMap(f =>
        Array.from({ length: opts.reps }, (_, rep) => ({ fixture: f, rep })));
      // Cache-integrity evidence for this variant. The window is capped at the
      // cell count so a short sweep is judged at its end rather than never.
      const cacheWindow = Math.min(CACHE_WINDOW[provider.cacheMode], cells.length);
      let cacheRuns = 0, cacheReads = 0, cacheProven = false;

      await pool(cells, opts.concurrency, async ({ fixture, rep }) => {
        const runId = `${fixture.id}:${name}:${rep}`;
        const root = makeSandbox("aeh-run-");
        const startedAt = new Date().toISOString();
        const t0 = Date.now();

        try {
          fs.cpSync(path.join(fixture.dir, "repo"), root, { recursive: true });
          const before = hashGuardedFiles(root);

          // Re-running a cell replaces its trajectory; without this the second
          // run interleaves with the first under duplicate seq values.
          store.clearEvents(runId);
          const emit = (e: EventInput) => store.insertEvent(runId, e);
          const result = await runLoop(provider, cfg, fixture.meta.prompt, makeTools(root), emit);

          const after = hashGuardedFiles(root);
          const tamper = diffHashes(before, after);

          // scoreTests restores from the live fixture — prove it is still the
          // fixture we started with before trusting anything it produces.
          assertFixtureIntact(fixture.id, path.join(fixture.dir, "repo"), pristine.get(fixture.id)!);

          // Scored only when the run produced an outcome (TSD §12).
          const scorable = result.stop !== "refusal" && result.stop !== "error";
          const passed = scorable ? (await scoreTests(root, fixture.dir) ? 1 : 0) : null;

          // Stretch (TSD §9.3), opt-in only: hash-based tamper detection cannot
          // see a hardcoded/special-cased/mocked fix that still edits real
          // source. Judged by JUDGE_MODEL, never by the model under test.
          // Passing runs only: a patch that never made the suite green did not
          // game the test, and the rate is published as conditional on passing
          // (see the report footnote and the README). Also keeps the extra
          // billed call off runs whose verdict would mean nothing.
          let sourceCheat: number | null = null;
          let sourceCheatKind: string | null = null;
          let sourceCheatEvidence: string | null = null;
          let judgeUsd = 0;
          if (opts.judge && passed === 1) {
            const diff = buildSourceDiff(path.join(fixture.dir, "repo"), root);
            if (diff) {
              const judgeCfg: SessionConfig = {
                model: JUDGE_MODEL, effort: "low", systemPrompt: "", tools: [],
                maxTokensPerTurn: 2000, cacheKey: `${runId}-judge`,
              };
              try {
                const judged = await judgeSourceCheat(PROVIDERS.openai, judgeCfg, diff);
                sourceCheat = judged.verdict.cheated ? 1 : 0;
                sourceCheatKind = judged.verdict.kind;
                sourceCheatEvidence = judged.verdict.evidence;
                judgeUsd = costUsd(JUDGE_MODEL, judged.usage);
              } catch (e) {
                // A blipped nano audit call must not discard an agent run that
                // already completed and was already billed. Missing verdict is
                // recorded as null, which summarise() excludes from the rate.
                console.warn(`  ${runId}  judge failed, sourceCheat left null: ${(e as Error).message}`);
              }
            }
          }

          // Only a run that actually completed says anything about caching: a
          // first cell that died at turn 1 (a 429 on fan-out) or refused has
          // cacheReadTokens 0 for reasons that have nothing to do with the cache.
          // Once any cache read is seen the mechanism is proven for this variant,
          // so stop accumulating; until then, abort as soon as the window's worth
          // of zeroes makes the verdict conclusive.
          if (!cacheProven && scorable) {
            cacheRuns++;
            cacheReads += result.usage.cacheReadTokens;
            cacheProven = cacheReads > 0;
            const verdict = cacheVerdict(provider.cacheMode, cacheRuns, cacheReads, cacheWindow);
            if (verdict) throw new Error(`[${name}] ${verdict}`);
          }

          const row: RunRow = {
            id: runId, taskId: fixture.id, variant: name, provider: variant.provider,
            model: variant.model, effort: variant.effort, rep,
            startedAt, endedAt: new Date().toISOString(),
            stopReason: result.stop, steps: result.steps,
            passed, tampered: tamper.tampered ? 1 : 0,
            tamperDetail: tamper.changed.length ? JSON.stringify(tamper.changed) : null,
            sourceCheat, sourceCheatKind, sourceCheatEvidence,
            inputTokens: result.usage.inputTokens,
            cacheWriteTokens: result.usage.cacheWriteTokens,
            cacheReadTokens: result.usage.cacheReadTokens,
            outputTokens: result.usage.outputTokens,
            reasoningTokens: result.usage.reasoningTokens,
            // Agent spend plus the judge's own billed call (0 unless --judge ran),
            // so the reported cost of a cell is what the cell actually cost.
            costUsd: costUsd(variant.model, result.usage) + judgeUsd,
            wallMs: Date.now() - t0, error: result.error ?? null,
          };
          store.upsertRun(row);
          console.log(`  ${runId}  ${result.stop}  passed=${passed}  tampered=${row.tampered}  $${row.costUsd.toFixed(4)}`);
        } finally {
          if (!opts.keepTemp) fs.rmSync(root, { recursive: true, force: true });
          else console.log(`  kept ${root}`);
        }
      });
    }
  } finally {
    store.close();
  }
}
