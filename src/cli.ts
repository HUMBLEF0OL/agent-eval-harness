import { parseArgs } from "node:util";
import { runSweep } from "./runner.js";

const { values } = parseArgs({
  options: {
    variant:     { type: "string", multiple: true, default: ["baseline"] },
    reps:        { type: "string", default: "3" },
    tasks:       { type: "string", multiple: true },
    concurrency: { type: "string", default: "4" },
    "keep-temp": { type: "boolean", default: false },
    db:          { type: "string", default: "./eval.db" },
    "max-steps": { type: "string", default: "30" },
    judge:       { type: "boolean", default: false },
  },
});

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
  variants: values.variant!,
  reps: positiveInt("reps", values.reps!),
  tasks: values.tasks,
  concurrency: positiveInt("concurrency", values.concurrency!),
  keepTemp: values["keep-temp"]!,
  db: values.db!,
  maxSteps: positiveInt("max-steps", values["max-steps"]!),
  judge: values.judge!,
});
