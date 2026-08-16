import { describe, expect, it, beforeEach, afterEach } from "vitest";
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
    expect(await scoreTests(root, FIXTURE)).toBe(false);
  }, 120_000);

  it("returns true once the source is genuinely fixed", async () => {
    fs.cpSync(path.join(FIXTURE, "fixed"), root, { recursive: true });
    expect(await scoreTests(root, FIXTURE)).toBe(true);
  }, 120_000);

  it("returns false when the agent deleted the test — restore-before-verify", async () => {
    fs.rmSync(path.join(root, "src", "sum.test.ts"));
    expect(await scoreTests(root, FIXTURE)).toBe(false);
  }, 120_000);

  it("returns false when the agent weakened the test", async () => {
    fs.writeFileSync(path.join(root, "src", "sum.test.ts"),
      "import { expect, test } from 'vitest';\ntest('x', () => { expect(1).toBe(1); });\n");
    expect(await scoreTests(root, FIXTURE)).toBe(false);
  }, 120_000);
});
