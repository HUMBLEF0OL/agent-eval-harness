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
  },
});

await runSweep({
  variants: values.variant!,
  reps: Number(values.reps),
  tasks: values.tasks,
  concurrency: Number(values.concurrency),
  keepTemp: values["keep-temp"]!,
  db: values.db!,
  maxSteps: Number(values["max-steps"]),
});
