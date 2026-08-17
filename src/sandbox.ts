import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, derived from this file's own location so it is right regardless of cwd. */
export const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** vitest's own CLI entry, resolved from the harness install rather than via `npx`.
 *  This is the exact path vitest's package.json declares as its `bin` (checked:
 *  `{ vitest: "./vitest.mjs" }` in vitest@3.2.x), so `process.execPath` can run it
 *  directly with no shell in between — see runVitest for why that matters. */
const VITEST_CLI = path.join(HARNESS_ROOT, "node_modules", "vitest", "vitest.mjs");

/** Sandboxes live on the harness's drive, NOT os.tmpdir(): fixtures carry no
 *  node_modules, so vitest resolves from the harness install, and Node's ESM
 *  resolver cannot walk up past a drive root (verified: C: sandbox + E: repo =
 *  ERR_MODULE_NOT_FOUND). */
export function makeSandbox(prefix: string): string {
  const base = path.join(HARNESS_ROOT, ".aeh-tmp");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

/** Runs the fixture suite inside `root`, resolving vitest from the harness install.
 *
 *  SIDE EFFECT: vite writes its cache into `<root>/node_modules/.vite/`, so after the
 *  first call the sandbox is no longer a byte-identical copy of the fixture. Harmless
 *  for tamper detection — hashGuardedFiles() skips node_modules — but do not treat a
 *  post-run sandbox as pristine, and never diff it wholesale against the fixture. */
export function runVitest(root: string, timeoutMs: number): SpawnSyncReturns<string> {
  // NO shell. `shell: true` was only ever here to let Windows resolve `npx`, and it
  // cost three things: (1) on timeout Node signals cmd.exe, NOT the node/vitest
  // grandchild, so every timed-out call leaked an orphaned vitest process tree —
  // observed live as 7 stray vitest/tinypool processes after one stopped sweep, still
  // issuing billable API calls; (2) it forced hand-quoting of `--root` because a path
  // with a space (this repo's has one) would split; (3) it emitted a DEP0190
  // deprecation warning on every call. Spawning the vitest CLI with our own node
  // instead removes all three: the timeout now signals the real process, and the
  // argv is passed as an array so no quoting is needed.
  //
  // Consequence worth knowing: `timeout` is now ACTUALLY ENFORCED. Through the shell
  // it was largely decorative — killing cmd.exe left the grandchild holding the stdio
  // pipes, so spawnSync went on waiting for them and a slow suite still finished. A
  // run that genuinely exceeds timeoutMs now comes back status=null, signal=SIGTERM.
  // Callers already treat a non-zero/null status as "tests did not pass", which is
  // the correct reading of a timed-out suite.
  return spawnSync(process.execPath, [VITEST_CLI, "run", "--root", root, "--reporter=basic"], {
    cwd: HARNESS_ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
  });
}
