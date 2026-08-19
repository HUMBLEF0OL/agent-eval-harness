import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import { openStore } from "./store.js";

/** Every sweep the README reports, and the number it reports it as. The databases
 *  beside this file are the evidence; this table is the CLAIM. They used to be
 *  unrelated: the databases were git-ignored, so a fresh clone could read "121 runs
 *  for $0.353" and had no way to check it — including no way to check the judge
 *  verdicts, the exact costs, or a single trajectory. All six are tracked now, and
 *  `npm run evidence` recomputes the headline from them and fails on any drift.
 *
 *  Costs are compared to four decimals, i.e. to a hundredth of a cent, which is
 *  finer than any figure the README quotes. */
export interface RecordedSweep { db: string; what: string; runs: number; usd: number; events: number }

export const RECORDED: RecordedSweep[] = [
  { db: "eval.db", what: "easy tier — 15 fixtures x 2 arms (run_tests ablation)", runs: 30, usd: 0.0328, events: 668 },
  { db: "eval-hard.db", what: "hard tier — 8 fixtures x 4 arms (tools + effort ladder)", runs: 32, usd: 0.0522, events: 812 },
  { db: "eval-control.db", what: "control tier — the 4 impossible fixtures that existed then", runs: 8, usd: 0.0502, events: 252 },
  { db: "eval-judge.db", what: "judge sensitivity — 21 fixtures x 2 arms with --judge", runs: 42, usd: 0.1824, events: 1379 },
  { db: "eval-control-final-retry.db", what: "control retry — 7 controls after the tier grew", runs: 8, usd: 0.0352, events: 236 },
  { db: "eval-budget-smoke.db", what: "hard live-spend cap, one real capped run", runs: 1, usd: 0.0001, events: 4 },
];

/** Every headline claim, each recomputable from the tracked databases above.
 *
 *  `cheats` is what makes the tamper number readable: a 0% tamper rate beside 12
 *  proven cheats is the finding, and neither half means much without the other.
 *
 *  `events` is here because "stored with complete replayable trajectories" is a
 *  published claim too, and it was the one claim the gate printed but did not
 *  check — 3,351 events could have drained away a hundred at a time with every
 *  number above still reconciling.
 *
 *  `supersededRuns` closes the other half of that: a re-run archives the attempt it
 *  replaces, so zero archived attempts across all six databases is the proof that
 *  these files are the WHOLE history of the published corpus and not the surviving
 *  layer of it. If a re-run ever lands here, this number has to be updated
 *  deliberately, with the attempt readable in superseded_runs. */
export const PUBLISHED = { runs: 121, usd: 0.3529, tampered: 0, cheats: 12, events: 3351, supersededRuns: 0 };

export interface SweepTotals {
  runs: number; usd: number; tampered: number; cheats: number;
  events: number; supersededRuns: number;
}

export function readSweep(db: string): SweepTotals {
  // Read-only: this gate must not be able to change the evidence it audits, and a
  // plain open writes (journal mode, plus any table SCHEMA has gained since).
  const store = openStore(db, { readonly: true });
  try {
    const runs = store.allRuns();
    return {
      runs: runs.length,
      usd: runs.reduce((a, r) => a + r.costUsd, 0),
      tampered: runs.reduce((a, r) => a + (r.tampered ?? 0), 0),
      cheats: runs.reduce((a, r) => a + (r.sourceCheat ?? 0), 0),
      events: runs.reduce((a, r) => a + store.eventsForRun(r.id).length, 0),
      supersededRuns: store.supersededRuns().length,
    };
  } finally { store.close(); }
}

const usd = (n: number) => `$${n.toFixed(4)}`;

/** Recomputes the published headline from the tracked databases. Returns the report
 *  lines and one message per disagreement — an empty list is the pass. */
export function auditEvidence(read: (db: string) => SweepTotals = readSweep): {
  lines: string[]; failures: string[];
} {
  const lines: string[] = [];
  const failures: string[] = [];
  const total = { runs: 0, usd: 0, tampered: 0, cheats: 0, events: 0, supersededRuns: 0 };

  for (const sweep of RECORDED) {
    if (!fs.existsSync(sweep.db)) {
      failures.push(`${sweep.db} is missing — the evidence for "${sweep.what}" is not in this tree`);
      continue;
    }
    const t = read(sweep.db);
    for (const [field, got, want] of [
      ["runs", t.runs, sweep.runs], ["events", t.events, sweep.events], ["cost", t.usd, sweep.usd],
    ] as const) {
      const same = field === "cost" ? got.toFixed(4) === (want as number).toFixed(4) : got === want;
      if (!same) failures.push(`${sweep.db}: ${field} is ${got} in the database, ${want} in RECORDED`);
    }
    lines.push(`  ${sweep.db.padEnd(28)} ${String(t.runs).padStart(3)} runs  ${usd(t.usd).padStart(9)}  ` +
      `${String(t.events).padStart(4)} events  tampered=${t.tampered}  cheats=${t.cheats}  ` +
      `superseded=${t.supersededRuns}  ${sweep.what}`);
    for (const k of ["runs", "usd", "tampered", "cheats", "events", "supersededRuns"] as const) total[k] += t[k];
  }

  lines.push(`  ${"TOTAL".padEnd(28)} ${String(total.runs).padStart(3)} runs  ${usd(total.usd).padStart(9)}  ` +
    `${String(total.events).padStart(4)} events  tampered=${total.tampered}  cheats=${total.cheats}  ` +
    `superseded=${total.supersededRuns}`);

  if (total.runs !== PUBLISHED.runs) failures.push(`published ${PUBLISHED.runs} runs, evidence holds ${total.runs}`);
  if (total.usd.toFixed(4) !== PUBLISHED.usd.toFixed(4)) {
    failures.push(`published ${usd(PUBLISHED.usd)} total, evidence holds ${usd(total.usd)}`);
  }
  if (total.tampered !== PUBLISHED.tampered) {
    failures.push(`published ${PUBLISHED.tampered} tampered runs, evidence holds ${total.tampered}`);
  }
  if (total.cheats !== PUBLISHED.cheats) {
    failures.push(`published ${PUBLISHED.cheats} judged cheats, evidence holds ${total.cheats}`);
  }
  if (total.events !== PUBLISHED.events) {
    failures.push(`published ${PUBLISHED.events} trajectory events, evidence holds ${total.events} — ` +
      `the run totals can reconcile while the trajectories behind them drain away`);
  }
  if (total.supersededRuns !== PUBLISHED.supersededRuns) {
    failures.push(`published ${PUBLISHED.supersededRuns} superseded attempts, evidence holds ` +
      `${total.supersededRuns} — a cell was re-run, so these databases are no longer the whole ` +
      `history of the published corpus unless PUBLISHED is updated to say so`);
  }
  return { lines, failures };
}

// pathToFileURL, not `file://${argv[1]}` — see the same guard in src/report.ts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { lines, failures } = auditEvidence();
  console.log("Recorded sweeps, recomputed from the tracked databases:\n");
  for (const l of lines) console.log(l);
  if (failures.length) {
    console.error(`\n${failures.length} disagreement(s) between the published claims and the evidence:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`\nok — every published figure recomputes from the databases in this tree ` +
      `(${PUBLISHED.runs} runs, ${usd(PUBLISHED.usd)}, ${PUBLISHED.events} events, ` +
      `${PUBLISHED.tampered} tampered, ${PUBLISHED.cheats} cheats, ` +
      `${PUBLISHED.supersededRuns} superseded attempts)`);
  }
}
