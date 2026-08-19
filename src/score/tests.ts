import * as fs from "node:fs";
import * as path from "node:path";
import { runVitest } from "../sandbox.js";
import { hashGuardedFiles } from "./tamper.js";

export interface TestVerdict {
  /** true/false is the model's result. NULL means vitest never produced an exit
   *  code — a spawn failure or a timeout — which is a HARNESS failure and must be
   *  scored as `error` / `passed = NULL` (TSD §12), never as a failed run. */
  passed: boolean | null;
  /** Non-null exactly when `passed` is null: the cause, for `runs.error`. */
  error: string | null;
}

/**
 * Restores every guarded file from the fixture, THEN runs vitest.
 * Restoring first is what makes `passed` honest by construction (TSD §9.1):
 * no amount of test tampering can produce a pass.
 * Mutates `root` — must run AFTER the post-run tamper hash is taken.
 */
export async function scoreTests(
  root: string,
  fixtureDir: string,
  timeoutMs = 120_000,
): Promise<TestVerdict> {
  const pristine = path.join(fixtureDir, "repo");

  // Delete every guarded file the agent may have added, then restore the originals.
  for (const rel of hashGuardedFiles(root).keys()) {
    fs.rmSync(path.join(root, rel), { force: true });
  }
  for (const rel of hashGuardedFiles(pristine).keys()) {
    const dst = path.join(root, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(pristine, rel), dst);
  }

  const r = runVitest(root, timeoutMs);
  // A spawn failure or a timeout is a HARNESS failure. It used to return false,
  // which put it in the primary metric as a model failure — the one number the
  // whole report is read for, biased by our own infrastructure. It is now an
  // unscorable run: the caller records stop=error, passed=NULL.
  if (r.error || r.status === null) {
    const cause = r.error
      ? r.error.message
      : `no exit code (timed out after ${timeoutMs}ms or killed by ${r.signal ?? "unknown signal"})`;
    const error = `scorer did not complete: vitest produced no verdict for ${root} — ${cause}` +
      (r.stderr ? `\nstderr: ${r.stderr.trim().slice(0, 2000)}` : "");
    console.error(`[scoreTests] WARNING: ${error}`);
    return { passed: null, error };
  }
  return { passed: r.status === 0, error: null };
}
