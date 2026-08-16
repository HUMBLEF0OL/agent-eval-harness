import * as fs from "node:fs";
import * as path from "node:path";
import { costUsd, promptTokens } from "./cost.js";
import { runLoop, type LoopConfig } from "./loop.js";
import { PROVIDERS } from "./provider/index.js";
import { makeSandbox } from "./sandbox.js";
import { diffHashes, hashGuardedFiles } from "./score/tamper.js";
import { scoreTests } from "./score/tests.js";
import { openStore, type RunRow } from "./store.js";
import { makeTools } from "./tools.js";
import { VARIANTS } from "./variants.js";
import type { EventInput, ProviderId, UsageTotals } from "./types.js";

export interface SweepOptions {
  variants: string[];
  reps: number;
  tasks?: string[];
  concurrency: number;
  keepTemp: boolean;
  db: string;
  maxSteps: number;
}

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

  try {
    for (const name of opts.variants) {
      const variant = VARIANTS[name];
      if (!variant) throw new Error(`unknown variant: ${name}`);
      const provider = PROVIDERS[variant.provider];
      if (!provider) throw new Error(`unknown provider ${variant.provider} in variant ${name}`);
      requireKey(variant.provider);          // fail before spending an hour

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
            sourceCheat: null, sourceCheatKind: null, sourceCheatEvidence: null,
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
