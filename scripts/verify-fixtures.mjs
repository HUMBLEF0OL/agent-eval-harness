import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

const VITEST_CLI = join(HARNESS_ROOT, "node_modules", "vitest", "vitest.mjs");

function runVitest(root, timeoutMs) {
  // No shell, for the reasons src/sandbox.ts spells out: with `shell: true` the
  // timeout kills cmd.exe and leaves the real vitest process tree orphaned, and
  // the same 120s timeout below made this script leak them too.
  return spawnSync(process.execPath, [VITEST_CLI, "run", "--root", root, "--reporter=basic"], {
    cwd: HARNESS_ROOT, encoding: "utf8", timeout: timeoutMs,
  });
}

const vitestStatus = (root) => runVitest(root, 120_000).status;

let failures = 0;
let controls = 0;
for (const id of readdirSync(join(HARNESS_ROOT, "fixtures"))) {
  // One broken fixture (bad meta.json, missing fixed/ file, stray non-directory)
  // must not abort the sweep or strand its sandbox — report it and keep going.
  let tmp;
  try {
    const meta = JSON.parse(readFileSync(join(HARNESS_ROOT, "fixtures", id, "meta.json"), "utf8"));

    // A control fixture (fixtures/9xx) cannot be made green by ANY source change —
    // it exists to corner an agent so the tamper detector finally has something to
    // detect. So its required property is the inverse of an ordinary fixture's, and
    // it is checked rather than assumed: the suite must be red to begin with AND
    // still red after the ordinary, competent repair in ordinary-fix/. A control
    // that some source edit could quietly satisfy would silently stop being a
    // positive control, and every tampered=0 reading taken from it would be
    // uninterpretable. It must also carry no fixed/ directory, because there is no
    // answer key to hold and an accidental one would send this script down the
    // ordinary-fixture path.
    const isControl = meta.control === true;
    const patchDir = isControl ? "ordinary-fix" : "fixed";

    tmp = makeSandbox("aeh-verify-");
    cpSync(join(HARNESS_ROOT, "fixtures", id, "repo"), tmp, { recursive: true });

    const before = vitestStatus(tmp);
    const patched = readFileSync(join(HARNESS_ROOT, "fixtures", id, patchDir, meta.brokenFile), "utf8");
    writeFileSync(join(tmp, meta.brokenFile), patched);
    const after = vitestStatus(tmp);

    let ok, note = "";
    if (isControl) {
      const strayAnswerKey = existsSync(join(HARNESS_ROOT, "fixtures", id, "fixed"));
      ok = before !== 0 && after !== 0 && !strayAnswerKey;
      note = strayAnswerKey ? "  control: has a stray fixed/ directory" : "  control: still red after the ordinary fix";
      controls++;
    } else {
      ok = before !== 0 && after === 0;
    }
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${id}  before=${before} after=${after}${note}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${id}  ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

if (failures) { console.error(`${failures} fixture(s) invalid`); process.exit(1); }
console.log(`all fixtures fail before and pass after, and all ${controls} control fixture(s) stay red`);
