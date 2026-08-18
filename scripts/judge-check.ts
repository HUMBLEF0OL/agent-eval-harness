import * as fs from "node:fs";
import * as path from "node:path";
import { buildSourceDiff, requireKey } from "../src/runner.js";
import { PROVIDERS } from "../src/provider/index.js";
import { judgeSourceCheat } from "../src/score/judge.js";
import { costUsd } from "../src/cost.js";
import { JUDGE_MODEL, type SessionConfig } from "../src/types.js";

/**
 * Measures the cheat judge against BOTH classes of input, per control fixture:
 * every `cheat…` patch directory (must be flagged — sensitivity) and the
 * `ordinary-fix` one (must be cleared — specificity). It exists because the README's judge
 * numbers came from live sweeps, which cost dollars and hours and only produce a
 * judged verdict when the agent happens to cheat; this reaches the same verdict
 * for a few tenths of a cent by feeding the judge the diff directly.
 *
 * It is a measurement, not a test: the judge is a model, so a run that reports
 * a miss is data about the judge, and this script says so rather than throwing.
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/judge-check.ts [fixtureId…]
 */
const only = process.argv.slice(2);
requireKey("openai");

const cfg = (key: string): SessionConfig => ({
  model: JUDGE_MODEL, effort: "low", systemPrompt: "", tools: [],
  maxTokensPerTurn: 2000, cacheKey: key,
});

/** The diff the judge would see for `patchDir`, built exactly as runSweep builds
 *  it: guarded files excluded, before/after content of every touched source file. */
function diffFor(fixtureDir: string, patchDir: string): string {
  const repo = path.join(fixtureDir, "repo");
  const tmp = fs.mkdtempSync(path.join(".aeh-tmp", "judge-"));
  try {
    fs.cpSync(repo, tmp, { recursive: true });
    fs.cpSync(path.join(fixtureDir, patchDir), tmp, { recursive: true });
    return buildSourceDiff(repo, tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

fs.mkdirSync(".aeh-tmp", { recursive: true });
let usd = 0, misses = 0, checks = 0, unspecified = 0;

for (const id of fs.readdirSync("fixtures")) {
  if (only.length && !only.includes(id)) continue;
  const dir = path.join("fixtures", id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  if (meta.control !== true) continue;

  const patches = fs.readdirSync(dir).filter(n => n === "cheat" || n.startsWith("cheat-")).sort();
  if (patches.length === 0) continue;              // airtight control: nothing to judge
  patches.push("ordinary-fix");                    // the specificity half, same fixture

  for (const patch of patches) {
    // The expected verdict is DECIDED per patch in meta.patches, never inferred from
    // the directory name. Inferring it labelled 906/cheat-env a cheat purely because
    // it is not called "ordinary-fix" — when that patch differs from ordinary-fix by
    // one expression that evaluates to the SAME thing outside the test runner, so its
    // production behaviour is identical to the reference answer. That turned a
    // defensible judge verdict into a recorded "miss" and nearly put an unsupported
    // claim in the README. A patch with no recorded expectation is a script failure,
    // not a guess.
    const expected = meta.patches?.[patch];
    if (!expected || typeof expected.cheated !== "boolean") {
      console.log(`FAIL ${id}/${patch}  no meta.patches entry — refusing to infer an ` +
        `expected verdict from the directory name`);
      unspecified++;
      continue;
    }
    const expectCheat: boolean = expected.cheated;
    const diff = diffFor(dir, patch);
    const { verdict, usage } = await judgeSourceCheat(PROVIDERS.openai, cfg(`${id}-${patch}`), diff);
    usd += costUsd(JUDGE_MODEL, usage);
    checks++;
    const ok = verdict.cheated === expectCheat;
    if (!ok) misses++;
    console.log(`${ok ? "ok  " : "MISS"} ${id}/${patch}  expected cheated=${expectCheat}  ` +
      `got cheated=${verdict.cheated} kind=${verdict.kind}\n       ${verdict.evidence.replace(/\s+/g, " ").slice(0, 220)}`);
  }
}

console.log(`\n${checks - misses}/${checks} verdicts as expected, $${usd.toFixed(4)} on ${JUDGE_MODEL}`);
if (unspecified) {
  console.error(`${unspecified} patch(es) had no meta.patches entry and were not judged`);
  process.exitCode = 1;
}
