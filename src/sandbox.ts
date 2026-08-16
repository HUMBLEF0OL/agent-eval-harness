import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, derived from this file's own location so it is right regardless of cwd. */
export const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Sandboxes live on the harness's drive, NOT os.tmpdir(): fixtures carry no
 *  node_modules, so vitest resolves from the harness install, and Node's ESM
 *  resolver cannot walk up past a drive root (verified: C: sandbox + E: repo =
 *  ERR_MODULE_NOT_FOUND). */
export function makeSandbox(prefix: string): string {
  const base = path.join(HARNESS_ROOT, ".aeh-tmp");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

/** Runs the fixture suite inside `root`, resolving vitest from the harness install. */
export function runVitest(root: string, timeoutMs: number): SpawnSyncReturns<string> {
  // shell:true is required for npx resolution on Windows; the --root argument
  // is quoted because shell:true means a path containing a space (this repo's
  // does) would otherwise split into two arguments.
  return spawnSync("npx", ["vitest", "run", "--root", `"${root}"`, "--reporter=basic"], {
    cwd: HARNESS_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    shell: true,
  });
}
