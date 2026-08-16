import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const SKIP = new Set(["node_modules", ".git", "dist", "coverage"]);

const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;

function isGuarded(rel: string): boolean {
  const base = path.basename(rel);
  // vite.config.* counts: vitest reads it too, so `test: { include: [] }` there
  // disables the suite exactly like the vitest.config.* version does.
  return TEST_FILE.test(base) || base === "package.json"
    || base.startsWith("vitest.config.") || base.startsWith("vite.config.");
}

export function hashGuardedFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (isGuarded(rel)) out.set(rel, createHash("sha256").update(fs.readFileSync(abs)).digest("hex"));
    }
  };
  walk(root);
  return out;
}

export function diffHashes(before: Map<string, string>, after: Map<string, string>) {
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter(k => before.get(k) !== after.get(k))
    .sort();
  return { tampered: changed.length > 0, changed };
}
