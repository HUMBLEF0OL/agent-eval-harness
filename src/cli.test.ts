import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { HARNESS_ROOT } from "./sandbox.js";

const OPTION_NAMES = [
  "variant", "reps", "tasks", "concurrency", "keep_temp", "db", "max_steps", "judge",
  "max_live_usd",
];

/** Runs the CLI the way a shell would. No key is needed: every case here is settled
 *  during argument handling, before requireKey or any network call.
 *
 *  The inherited environment is scrubbed of `npm_config_<our option names>` first, so
 *  a test means the same thing whether the suite was launched by `npm test`, `npx
 *  vitest` or an editor. The provider key is scrubbed for the same reason:
 *  the well-formed case below asserts the run stops at requireKey, which would break
 *  for anyone whose shell happens to export a key. Note this spawns cli.ts directly
 *  rather than through `npm run sweep`, so it never picks up .env.local either — the
 *  unit suite stays key-independent by construction, not by luck. */
function cli(args: string[], env: Record<string, string> = {}) {
  const clean = { ...process.env };
  for (const n of OPTION_NAMES) delete clean[`npm_config_${n}`];
  delete clean["OPENAI_API_KEY"];
  const r = spawnSync(
    process.execPath,
    [path.join(HARNESS_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
     path.join(HARNESS_ROOT, "src", "cli.ts"), ...args],
    { cwd: HARNESS_ROOT, encoding: "utf8", timeout: 60_000, env: { ...clean, ...env } },
  );
  return { status: r.status, err: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("cli argument handling", { timeout: 15_000 }, () => {
  // The argv Windows PowerShell actually produces: it strips the bare `--`, npm
  // absorbs the flag NAMES as its own config, and only the values are forwarded.
  it("refuses a flag-stripped invocation instead of sweeping the default variant", () => {
    const { status, err } = cli(["nano", "1", "901-contradictory-expectations"]);
    expect(status).toBe(2);
    expect(err).toMatch(/unexpected positional argument\(s\): nano 1 901-contradictory-expectations/);
    expect(err).toMatch(/DEFAULT variant \(baseline \/ gpt-5\.6-terra \/ 3 reps\)/);
    expect(err).toMatch(/npm run sweep "--" --variant nano/);
  });

  // The dangerous variant of the same bug: a boolean flag leaves NO positional, so
  // argv is empty and a positional check alone sees a clean default sweep. npm's
  // own `npm_config_*` export is the only remaining evidence.
  it("catches a swallowed boolean flag, which leaves argv completely empty", () => {
    const { status, err } = cli([], { npm_config_judge: "true" });
    expect(status).toBe(2);
    expect(err).toMatch(/npm swallowed these flags as its own config: --judge/);
  });

  it("reports every swallowed flag, hyphenated names included", () => {
    const { status, err } = cli([], { npm_config_judge: "true", npm_config_keep_temp: "true" });
    expect(status).toBe(2);
    expect(err).toMatch(/--keep-temp/);
    expect(err).toMatch(/--judge/);
  });

  // A user's own .npmrc may set a key that collides with one of our option names.
  // That must not block a flag which did arrive correctly, or the guard becomes a
  // false positive that blocks valid sweeps.
  it("ignores a colliding npm config when the flag itself came through", () => {
    const { status, err } = cli(["--variant", "nano", "--db", "./eval.db", "--reps", "1"],
                                { npm_config_db: "./eval.db" });
    expect(status).not.toBe(2);
    expect(err).toMatch(/OPENAI_API_KEY is not set/);
  });

  it("rejects a non-integer --reps rather than running zero cells and exiting 0", () => {
    const { status, err } = cli(["--variant", "nano", "--reps", "abc"]);
    expect(status).toBe(2);
    expect(err).toMatch(/--reps must be a positive integer, got: abc/);
  });

  it("accepts --max-live-usd without reaching a live call", () => {
    const { status, err } = cli([
      "--variant", "nano", "--reps", "1", "--max-live-usd", "0.25",
    ]);
    expect(status).not.toBe(2);
    expect(err).toMatch(/OPENAI_API_KEY is not set/);
  });

  it.each(["0", "-0.01", "NaN", "Infinity", "abc"])(
    "rejects invalid --max-live-usd value %s",
    raw => {
      const args = raw.startsWith("-") ? [`--max-live-usd=${raw}`] : ["--max-live-usd", raw];
      const { status, err } = cli(args);
      expect(status).toBe(2);
      expect(err).toContain(`--max-live-usd must be a positive finite number, got: ${raw}`);
    },
  );

  it("accepts a well-formed invocation, failing later at the key check", () => {
    const { status, err } = cli(["--variant", "nano", "--reps", "1"]);
    expect(status).not.toBe(2);
    expect(err).toMatch(/OPENAI_API_KEY is not set/);
  });
});
