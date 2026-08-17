import { parseArgs } from "node:util";
import { runSweep } from "./runner.js";

// `as const` is what lets parseArgs infer `values` precisely, and it also makes any
// array literal in here readonly — which ParseArgsOptionsConfig rejects. So
// --variant's default lives at the use site below instead of in this table.
const OPTIONS = {
  variant:     { type: "string",  multiple: true },
  reps:        { type: "string",  default: "3" },
  tasks:       { type: "string",  multiple: true },
  concurrency: { type: "string",  default: "4" },
  "keep-temp": { type: "boolean", default: false },
  db:          { type: "string",  default: "./eval.db" },
  "max-steps": { type: "string",  default: "30" },
  judge:       { type: "boolean", default: false },
} as const;

const { values, positionals } = parseArgs({
  // Positionals are ACCEPTED here only so a mangled invocation can be diagnosed
  // below instead of dying inside node:util with a stack trace that points at
  // parse_args and implies a bug in this file.
  allowPositionals: true,
  options: OPTIONS,
});

/** Windows PowerShell strips a bare `--` before npm ever sees it. npm then treats
 *  this script's flags as its OWN config, and forwards only what is left over — so
 *  `npm run sweep -- --variant nano --reps 1` reaches us as `nano 1`, and
 *  `npm run sweep -- --judge` reaches us as nothing at all. bash and zsh pass `--`
 *  through untouched, which is why the identical command works there. Quoting it
 *  (`"--"`) is portable and works in every shell.
 *
 *  The crash is not the hazard; `values` is. Every option has a default, so a
 *  stripped invocation runs a PERFECTLY VALID sweep of the wrong thing: `baseline`
 *  on gpt-5.6-terra at 3 reps — 45 runs and roughly $27 charged for an experiment
 *  nobody asked for. Detection therefore cannot rely on leftover positionals alone,
 *  because a boolean flag leaves none. npm exports everything it swallowed as
 *  `npm_config_<name>` (hyphens to underscores, verified: `--keep-temp` becomes
 *  `npm_config_keep_temp=true`), so the swallowed names are recoverable from the
 *  environment even when argv is empty.
 *
 *  A name is only treated as swallowed when it is absent from argv, so a legitimate
 *  `.npmrc` key that happens to collide with one of our option names cannot block a
 *  correctly-passed flag. */
const argv = process.argv.slice(2);
const swallowed = Object.keys(OPTIONS).filter(name =>
  process.env[`npm_config_${name.replace(/-/g, "_")}`] !== undefined &&
  !argv.some(a => a === `--${name}` || a.startsWith(`--${name}=`)));

if (positionals.length || swallowed.length) {
  const detail = swallowed.length
    ? `npm swallowed these flags as its own config: ${swallowed.map(n => `--${n}`).join(" ")}`
    : `unexpected positional argument(s): ${positionals.join(" ")}`;
  console.error(
    `${detail}\n\n` +
    `The shell ate the \`--\` separator before npm saw it, so npm took this script's\n` +
    `flags for its own and forwarded only their values. Running anyway would sweep the\n` +
    `DEFAULT variant (baseline / gpt-5.6-terra / 3 reps), not what you asked for.\n\n` +
    `Quote the separator — portable across PowerShell, bash and zsh:\n` +
    `  npm run sweep "--" --variant nano --reps 1\n` +
    `Or skip npm entirely:\n` +
    `  npx tsx src/cli.ts --variant nano --reps 1`,
  );
  process.exit(2);
}

/** `--reps abc` is NaN and `--concurrency 0` makes pool() do nothing: both would
 *  otherwise produce a sweep that runs no cells and exits 0, which reads as a
 *  successful measurement. */
function positiveInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`--${flag} must be a positive integer, got: ${raw}`);
    process.exit(2);
  }
  return n;
}

await runSweep({
  variants: values.variant ?? ["baseline"],
  reps: positiveInt("reps", values.reps!),
  tasks: values.tasks,
  concurrency: positiveInt("concurrency", values.concurrency!),
  keepTemp: values["keep-temp"]!,
  db: values.db!,
  maxSteps: positiveInt("max-steps", values["max-steps"]!),
  judge: values.judge!,
});
