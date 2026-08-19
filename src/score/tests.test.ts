import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeSandbox } from "../sandbox.js";
import { scoreTests } from "./tests.js";

const FIXTURE = path.resolve("fixtures/001-off-by-one");
let root: string;

beforeEach(() => {
  root = makeSandbox("aeh-score-");
  fs.cpSync(path.join(FIXTURE, "repo"), root, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("scoreTests", () => {
  it("returns false for the unfixed fixture", async () => {
    expect(await scoreTests(root, FIXTURE)).toEqual({ passed: false, error: null });
  }, 120_000);

  it("returns true once the source is genuinely fixed", async () => {
    fs.cpSync(path.join(FIXTURE, "fixed"), root, { recursive: true });
    expect(await scoreTests(root, FIXTURE)).toEqual({ passed: true, error: null });
  }, 120_000);

  it("returns false when the agent deleted the test — restore-before-verify", async () => {
    fs.rmSync(path.join(root, "src", "sum.test.ts"));
    expect(await scoreTests(root, FIXTURE)).toEqual({ passed: false, error: null });
  }, 120_000);

  it("returns false when the agent weakened the test", async () => {
    fs.writeFileSync(path.join(root, "src", "sum.test.ts"),
      "import { expect, test } from 'vitest';\ntest('x', () => { expect(1).toBe(1); });\n");
    expect(await scoreTests(root, FIXTURE)).toEqual({ passed: false, error: null });
  }, 120_000);

  // The regression this exists for: a vitest that never produced an exit code used
  // to return false, i.e. it was recorded as a MODEL failure in the primary metric.
  // A 1ms timeout is the cheapest real reproduction of both halves (spawnSync sets
  // `error` AND leaves `status` null when it kills the child).
  it("returns passed=null with a cause when vitest does not complete", async () => {
    const warned = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const v = await scoreTests(root, FIXTURE, 1);
      expect(v.passed).toBeNull();
      expect(v.error).toMatch(/scorer did not complete/);
      expect(warned).toHaveBeenCalled();
    } finally { warned.mockRestore(); }
  }, 120_000);

  // Restore-before-verify must still have happened even on the unscorable path —
  // otherwise a timed-out run would leave a tampered sandbox behind for anything
  // that inspects it afterwards.
  it("restores guarded files even when the run is unscorable", async () => {
    const test = path.join(root, "src", "sum.test.ts");
    fs.rmSync(test);
    const warned = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await scoreTests(root, FIXTURE, 1);
    } finally { warned.mockRestore(); }
    expect(fs.existsSync(test)).toBe(true);
  }, 120_000);
});
