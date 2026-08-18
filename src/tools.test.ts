import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ALL_TOOLS, makeTools, resolveInRoot } from "./tools.js";
import { HARNESS_ROOT, makeSandbox } from "./sandbox.js";

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

  // Escapes on every platform. A POSIX-absolute path is absolute on Windows too --
  // path.resolve maps "/etc/passwd" onto the current drive -- so it belongs here.
  it.each([
    "../../etc/passwd",
    "src/../../escape.txt",
    "/etc/passwd",
  ])("rejects %s", (p) => {
    expect(() => resolveInRoot(root, p)).toThrow(/escapes project root/);
  });

  it("rejects an absolute path outside root, whatever absolute means here", () => {
    // Derived from os.tmpdir() so it is genuinely absolute on all three platforms,
    // and a SIBLING of root rather than a child (root is itself a mkdtemp under
    // tmpdir, so a naive tmpdir-relative path would land inside it and pass).
    const outside = path.join(os.tmpdir(), "aeh-outside-probe.txt");
    expect(() => resolveInRoot(root, outside)).toThrow(/escapes project root/);
  });

  // A drive-absolute path is an escape ONLY on Windows. On Linux and macOS a drive
  // letter means nothing and a backslash is a legal filename character, so the same
  // string is a RELATIVE name that resolves inside root -- and accepting it is the
  // correct answer, not a hole in the guard. Asserting one behaviour for two path
  // grammars is what made this the only test to fail when CI first ran off Windows:
  // it encoded the platform instead of the security property.
  const WINDOWS_DRIVE_ABSOLUTE = "C:\\Windows\\System32\\config";
  if (process.platform === "win32") {
    it("rejects a drive-absolute path (Windows only)", () => {
      expect(() => resolveInRoot(root, WINDOWS_DRIVE_ABSOLUTE)).toThrow(/escapes project root/);
    });
  } else {
    it("treats a Windows drive path as an ordinary filename (POSIX only)", () => {
      const rel = path.relative(root, resolveInRoot(root, WINDOWS_DRIVE_ABSOLUTE));
      expect(rel.startsWith("..")).toBe(false);
      expect(path.isAbsolute(rel)).toBe(false);
    });
  }

  // The lexical check alone passes this: <root>/linked/pwned.txt is lexically
  // inside root. Only a realpath comparison catches it — and it has to, because
  // sharing a node_modules into the sandbox by symlink is the obvious next step.
  it("rejects a path that escapes through a symlinked directory", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "aeh-outside-"));
    const link = path.join(root, "linked");
    // "junction" so Windows needs no elevation; the type arg is ignored on POSIX.
    fs.symlinkSync(outside, link, "junction");
    try {
      expect(() => resolveInRoot(root, "linked/pwned.txt")).toThrow(/escapes project root/);
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
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

  // Sandbox must come from makeSandbox(): os.tmpdir() is on another drive and
  // Node's ESM resolver cannot reach the harness install from there.
  it("runs the suite of a broken fixture and reports its failing exit code", async () => {
    const sandbox = makeSandbox("aeh-runtests-");
    try {
      fs.cpSync(path.join(HARNESS_ROOT, "fixtures", "001-off-by-one", "repo"), sandbox, { recursive: true });
      const out = await makeTools(sandbox).dispatch("run_tests", {});
      expect(out.isError).toBeFalsy();
      expect(out.content).not.toMatch(/spawn error/);
      expect(out.content).toMatch(/^exit code: [1-9]/);   // real non-zero exit, not "timeout"
      expect(out.content).toMatch(/sum\.test\.ts/);        // real vitest output about the fixture
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }, 90_000);
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
