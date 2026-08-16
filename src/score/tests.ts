import * as fs from "node:fs";
import * as path from "node:path";
import { runVitest } from "../sandbox.js";
import { hashGuardedFiles } from "./tamper.js";

/**
 * Restores every guarded file from the fixture, THEN runs vitest.
 * Restoring first is what makes `passed` honest by construction (TSD §9.1):
 * no amount of test tampering can produce a pass.
 * Mutates `root` — must run AFTER the post-run tamper hash is taken.
 */
export async function scoreTests(root: string, fixtureDir: string): Promise<boolean> {
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

  const r = runVitest(root, 120_000);
  // A spawn failure or a timeout is a HARNESS failure that scores identically to a
  // model failure. Say so loudly — a silent false is the worst kind of wrong number.
  if (r.error || r.status === null) {
    console.error(
      `[scoreTests] WARNING: vitest did not complete for ${root} — scoring this run as FAILED. ` +
      `cause: ${r.error ? r.error.message : `no exit code (timed out after 120s or killed by ${r.signal ?? "unknown signal"})`}` +
      (r.stderr ? `\n[scoreTests] stderr: ${r.stderr.trim().slice(0, 2000)}` : ""),
    );
  }
  return r.status === 0;
}
