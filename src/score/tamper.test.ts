import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { diffHashes, hashGuardedFiles } from "./tamper.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aeh-tamper-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.test.ts"), "test('x', () => {})");
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;");
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "vitest.config.ts"), "export default {}");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("hashGuardedFiles", () => {
  it("guards test files, package.json, and vitest config — but not source", () => {
    const keys = [...hashGuardedFiles(root).keys()].sort();
    expect(keys).toEqual(["package.json", "src/a.test.ts", "vitest.config.ts"]);
  });
});

describe("diffHashes", () => {
  it("reports no tampering when nothing changed", () => {
    const before = hashGuardedFiles(root);
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 2;");   // source edit is fine
    expect(diffHashes(before, hashGuardedFiles(root))).toEqual({ tampered: false, changed: [] });
  });

  it("detects a modified test", () => {
    const before = hashGuardedFiles(root);
    fs.writeFileSync(path.join(root, "src", "a.test.ts"), "test.skip('x', () => {})");
    expect(diffHashes(before, hashGuardedFiles(root))).toEqual({ tampered: true, changed: ["src/a.test.ts"] });
  });

  it("detects a deleted test", () => {
    const before = hashGuardedFiles(root);
    fs.rmSync(path.join(root, "src", "a.test.ts"));
    expect(diffHashes(before, hashGuardedFiles(root)).changed).toEqual(["src/a.test.ts"]);
  });

  it("detects an added test file", () => {
    const before = hashGuardedFiles(root);
    fs.writeFileSync(path.join(root, "src", "b.test.ts"), "test('y', () => {})");
    expect(diffHashes(before, hashGuardedFiles(root)).changed).toEqual(["src/b.test.ts"]);
  });

  it("detects config-level test exclusion", () => {
    const before = hashGuardedFiles(root);
    fs.writeFileSync(path.join(root, "vitest.config.ts"), "export default { test: { include: [] } }");
    expect(diffHashes(before, hashGuardedFiles(root)).changed).toEqual(["vitest.config.ts"]);
  });

  it("detects test exclusion smuggled into a new vite.config.ts", () => {
    const before = hashGuardedFiles(root);
    fs.writeFileSync(path.join(root, "vite.config.ts"), "export default { test: { include: [] } }");
    expect(diffHashes(before, hashGuardedFiles(root)).changed).toEqual(["vite.config.ts"]);
  });

  it("detects a modified sibling-extension test (.spec.tsx)", () => {
    fs.writeFileSync(path.join(root, "src", "b.spec.tsx"), "test('y', () => {})");
    const before = hashGuardedFiles(root);
    fs.writeFileSync(path.join(root, "src", "b.spec.tsx"), "test.skip('y', () => {})");
    expect(diffHashes(before, hashGuardedFiles(root)).changed).toEqual(["src/b.spec.tsx"]);
  });
});
