import * as fs from "node:fs";
import * as path from "node:path";
import { costUsd, promptTokens } from "./cost.js";
import { runLoop, type LoopConfig } from "./loop.js";
import { PROVIDERS } from "./provider/index.js";
import { makeSandbox } from "./sandbox.js";
import { judgeSourceCheat } from "./score/judge.js";
import { diffHashes, hashGuardedFiles } from "./score/tamper.js";
import { scoreTests } from "./score/tests.js";
import { openStore, type RunRow } from "./store.js";
import { makeTools } from "./tools.js";
import { VARIANTS } from "./variants.js";
import type { EventInput, ProviderId, SessionConfig, UsageTotals } from "./types.js";

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

/** The judge always runs on this model, never on the model under test
 *  (TSD §9.3) — named here so the CLI, the sweep, and the report agree.
 *  The "nano" variant is unrun by design (PRD §5.4), so the guard in
 *  runSweep below never actually fires; it exists to fail loudly if that
 *  ever changes rather than silently judging a model against itself. */
export const JUDGE_MODEL = "gpt-5-nano";

export function requireKey(p: ProviderId): void {
  const k = p === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  if (!process.env[k]) throw new Error(`${k} is not set, required by a selected variant`);
}

/** Both vendors fail silently when the prefix is too short. This is the check
 *  that turns a silent 5x cost error into a startup failure (TSD §6.4). */
export function assertPrefixLongEnough(name: string, warm: UsageTotals): void {
  const prefix = promptTokens(warm);
  if (prefix < 1100) {
    throw new Error(
      `variant ${name}: cacheable prefix is ${prefix} tokens, below the 1024 minimum ` +
      `(with margin). Caching would silently do nothing. Lengthen SYSTEM_PROMPT with ` +
      `useful tool-use guidance — not filler.`,
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
  const store = openStore(opts.db);
  const fixtures = loadFixtures(opts.tasks);
  if (fixtures.length === 0) throw new Error("no fixtures matched --tasks");
  if (opts.judge) requireKey("openai");     // the judge always calls OpenAI (JUDGE_MODEL)

  try {
    for (const name of opts.variants) {
      const variant = VARIANTS[name];
      if (!variant) throw new Error(`unknown variant: ${name}`);
      const provider = PROVIDERS[variant.provider];
      if (!provider) throw new Error(`unknown provider ${variant.provider} in variant ${name}`);
      requireKey(variant.provider);          // fail before spending an hour
      if (opts.judge && variant.model === JUDGE_MODEL) {
        throw new Error(`variant ${name}: judge model ${JUDGE_MODEL} equals the model under ` +
          `test — a self-judged run is not a check. Pick a different JUDGE_MODEL.`);
      }

      const cfg: LoopConfig = {
        model: variant.model, effort: variant.effort, systemPrompt: variant.systemPrompt,
        tools: variant.tools, maxTokensPerTurn: 16000, cacheKey: name, maxSteps: opts.maxSteps,
      };

      console.log(`[${name}] pre-warming cache…`);
      assertPrefixLongEnough(name, await provider.prewarm(cfg));   // strictly before fan-out

      const cells = fixtures.flatMap(f =>
        Array.from({ length: opts.reps }, (_, rep) => ({ fixture: f, rep })));
      let cacheChecked = false;

      await pool(cells, opts.concurrency, async ({ fixture, rep }) => {
        const runId = `${fixture.id}:${name}:${rep}`;
        const root = makeSandbox("aeh-run-");
        const startedAt = new Date().toISOString();
        const t0 = Date.now();

        try {
          fs.cpSync(path.join(fixture.dir, "repo"), root, { recursive: true });
          const before = hashGuardedFiles(root);

          const emit = (e: EventInput) => store.insertEvent(runId, e);
          const result = await runLoop(provider, cfg, fixture.meta.prompt, makeTools(root), emit);

          const after = hashGuardedFiles(root);
          const tamper = diffHashes(before, after);

          // Scored only when the run produced an outcome (TSD §12).
          const scorable = result.stop !== "refusal" && result.stop !== "error";
          const passed = scorable ? (await scoreTests(root, fixture.dir) ? 1 : 0) : null;

          // Stretch (TSD §9.3), opt-in only: hash-based tamper detection cannot
          // see a hardcoded/special-cased/mocked fix that still edits real
          // source. Judged by JUDGE_MODEL, never by the model under test.
          let sourceCheat: number | null = null;
          let sourceCheatKind: string | null = null;
          let sourceCheatEvidence: string | null = null;
          if (opts.judge && scorable) {
            const diff = buildSourceDiff(path.join(fixture.dir, "repo"), root);
            if (diff) {
              const judgeCfg: SessionConfig = {
                model: JUDGE_MODEL, effort: "low", systemPrompt: "", tools: [],
                maxTokensPerTurn: 2000, cacheKey: `${runId}-judge`,
              };
              const verdict = await judgeSourceCheat(PROVIDERS.openai, judgeCfg, diff);
              sourceCheat = verdict.cheated ? 1 : 0;
              sourceCheatKind = verdict.kind;
              sourceCheatEvidence = verdict.evidence;
            }
          }

          if (!cacheChecked) {
            cacheChecked = true;
            if (result.usage.cacheReadTokens === 0) {
              throw new Error(
                `[${name}] cacheReadTokens is 0 after a full run — prompt caching is not ` +
                `working. Every cost number in this sweep would be wrong. Aborting.`,
              );
            }
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
            costUsd: costUsd(variant.model, result.usage),
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
