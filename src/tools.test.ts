import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ALL_TOOLS, makeTools, resolveInRoot } from "./tools.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aeh-tools-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "sum.ts"), "export const sum = 1;");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("resolveInRoot", () => {
  it("accepts a plain relative path", () => {
    expect(resolveInRoot(root, "src/sum.ts")).toBe(path.join(root, "src", "sum.ts"));
  });

  it.each([
    "../../etc/passwd",
    "src/../../escape.txt",
    "C:\\Windows\\System32\\config",
    "/etc/passwd",
  ])("rejects %s", (p) => {
    expect(() => resolveInRoot(root, p)).toThrow(/escapes project root/);
  });
});

describe("makeTools", () => {
  it("lists files as root-relative paths with forward slashes", async () => {
    const out = await makeTools(root).dispatch("list_files", {});
    expect(out.isError).toBeFalsy();
    expect(out.content.split("\n")).toContain("src/sum.ts");
  });

  it("reads a file", async () => {
    const out = await makeTools(root).dispatch("read_file", { path: "src/sum.ts" });
    expect(out.content).toBe("export const sum = 1;");
  });

  it("writes a file and creates missing directories", async () => {
    const out = await makeTools(root).dispatch("write_file", { path: "src/deep/new.ts", content: "x" });
    expect(out.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(root, "src", "deep", "new.ts"), "utf8")).toBe("x");
  });

  it("returns an error result instead of throwing on escape", async () => {
    const out = await makeTools(root).dispatch("write_file", { path: "../../pwned.txt", content: "x" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/escapes project root/);
    expect(fs.existsSync(path.join(root, "..", "..", "pwned.txt"))).toBe(false);
  });

  it("returns an error result for an unknown tool", async () => {
    const out = await makeTools(root).dispatch("rm_rf", {});
    expect(out.isError).toBe(true);
  });

  it("returns an error result for a missing required argument", async () => {
    const out = await makeTools(root).dispatch("read_file", {});
    expect(out.isError).toBe(true);
  });
});

describe("ALL_TOOLS", () => {
  it("is sorted by name so the cacheable prefix is byte-stable", () => {
    const names = ALL_TOOLS.map(t => t.name);
    expect(names).toEqual([...names].sort());
  });

  it("uses schemas that satisfy OpenAI strict mode", () => {
    for (const t of ALL_TOOLS) {
      expect(t.parameters.additionalProperties).toBe(false);
      expect([...t.parameters.required].sort()).toEqual(Object.keys(t.parameters.properties).sort());
    }
  });
});
