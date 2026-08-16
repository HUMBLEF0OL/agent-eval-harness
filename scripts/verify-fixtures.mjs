import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Inline copy of src/sandbox.ts's makeSandbox/runVitest — a .mjs script cannot
// import the .ts helper. See src/sandbox.ts for the full rationale: sandboxes
// must live on the harness's own drive (not os.tmpdir(), which is C: while
// this repo is on E:), and vitest is always run with --root pointed at the
// sandbox while resolving from the harness's single root install.
const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function makeSandbox(prefix) {
  const base = join(HARNESS_ROOT, ".aeh-tmp");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

function runVitest(root, timeoutMs) {
  return spawnSync("npx", ["vitest", "run", "--root", `"${root}"`, "--reporter=basic"], {
    cwd: HARNESS_ROOT, encoding: "utf8", timeout: timeoutMs, shell: true,
  });
}

const vitestStatus = (root) => runVitest(root, 120_000).status;

let failures = 0;
for (const id of readdirSync(join(HARNESS_ROOT, "fixtures"))) {
  const meta = JSON.parse(readFileSync(join(HARNESS_ROOT, "fixtures", id, "meta.json"), "utf8"));
  const tmp = makeSandbox("aeh-verify-");
  cpSync(join(HARNESS_ROOT, "fixtures", id, "repo"), tmp, { recursive: true });

  const before = vitestStatus(tmp);
  const fixed = readFileSync(join(HARNESS_ROOT, "fixtures", id, "fixed", meta.brokenFile), "utf8");
  writeFileSync(join(tmp, meta.brokenFile), fixed);
  const after = vitestStatus(tmp);
  rmSync(tmp, { recursive: true, force: true });

  const ok = before !== 0 && after === 0;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${id}  before=${before} after=${after}`);
}

if (failures) { console.error(`${failures} fixture(s) invalid`); process.exit(1); }
console.log("all fixtures fail before and pass after");
