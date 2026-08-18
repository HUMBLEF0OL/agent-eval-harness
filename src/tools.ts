import * as fs from "node:fs";
import * as path from "node:path";
import { runVitest } from "./sandbox.js";
import type { ToolHandlers, ToolOutput, ToolSpec } from "./types.js";

export class ToolError extends Error {}

/** Sorted by name — the cacheable prefix must be byte-stable (TSD §6.3). */
export const ALL_TOOLS: ToolSpec[] = [
  {
    name: "list_files",
    description:
      "List every file in the project, as paths relative to the project root. " +
      "Call this first to orient yourself before reading anything.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "read_file",
    description:
      "Read a file's full contents. Call this before editing any file — you cannot " +
      "edit correctly without seeing the current content.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the project root" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "run_tests",
    description:
      "Run the project's test suite and return the exit code plus output. " +
      "Call this after making a change to confirm whether it actually fixed the failure.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "write_file",
    description:
      "Overwrite a file with new content. This replaces the entire file, so include " +
      "the complete new contents, not a diff or a fragment.",
    parameters: {
      type: "object",
      properties: {
        path:    { type: "string", description: "Path relative to the project root" },
        content: { type: "string", description: "Complete new file contents" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
];

/** Trust boundary. Every model-supplied path passes through here. */
export function resolveInRoot(root: string, p: string): string {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ToolError(`path escapes project root: ${p}`);
  }
  // Lexical is not enough. A symlink at <root>/node_modules is lexically inside
  // root but resolves outside it, so write_file("node_modules/x") would pass the
  // check above and land in the real project — and run_tests then executes
  // model-authored code with harness privileges. So compare resolved paths too.
  // The target itself need not exist yet (write_file creates files), so resolve
  // the nearest existing ancestor and re-append the rest.
  let probe = abs;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const real = path.join(fs.realpathSync(probe), path.relative(probe, abs));
  const realRel = path.relative(fs.realpathSync(root), real);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new ToolError(`path escapes project root via symlink: ${p}`);
  }
  return abs;
}

const SKIP = new Set(["node_modules", ".git", "dist", "coverage"]);

function walk(dir: string, root: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, root, out);
    else out.push(path.relative(root, abs).split(path.sep).join("/"));
  }
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string") throw new ToolError(`missing or non-string argument: ${key}`);
  return v;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n…[truncated, ${s.length - n} more chars]`;
}

export function makeTools(root: string): ToolHandlers {
  async function run(name: string, input: Record<string, unknown>): Promise<ToolOutput> {
    switch (name) {
      case "list_files": {
        const out: string[] = [];
        walk(root, root, out);
        return { content: out.sort().join("\n") };
      }
      case "read_file":
        return { content: fs.readFileSync(resolveInRoot(root, str(input, "path")), "utf8") };
      case "write_file": {
        const abs = resolveInRoot(root, str(input, "path"));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, str(input, "content"), "utf8");
        return { content: `wrote ${input["path"]}` };
      }
      case "run_tests": {
        const r = runVitest(root, 60_000);
        return {
          content: [
            `exit code: ${r.status ?? "timeout"}`,
            ...(r.error ? [`spawn error: ${r.error.message}`] : []),
            truncate(r.stdout ?? "", 4096),
            truncate(r.stderr ?? "", 2048),
          ].join("\n"),
        };
      }
      default:
        throw new ToolError(`unknown tool: ${name}`);
    }
  }

  return {
    // Never throws: a harness bug degrades a run, it does not abort the sweep (TSD §4.3).
    async dispatch(name, input) {
      try {
        return await run(name, input);
      } catch (e) {
        return { content: e instanceof Error ? e.message : String(e), isError: true };
      }
    },
  };
}
