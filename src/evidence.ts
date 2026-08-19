import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import { openStore } from "./store.js";

/** Every sweep the README reports, and the number it reports it as. The databases
 *  beside this file are the evidence; this table is the CLAIM. They used to be
 *  unrelated: the databases were git-ignored, so a fresh clone could read "121 runs
 *  for $0.353" and had no way to check it — including no way to check the judge
 *  verdicts, the exact costs, or a single trajectory. All nine databases are tracked
 *  now, and `npm run evidence` recomputes the headline from them and fails on any
 *  drift. Six predate the rev-6 schema; the last three were recorded under it and are
 *  the ones with reps, i.e. the ones any published p-value comes from.
 *
 *  Costs are compared to four decimals, i.e. to a hundredth of a cent, which is
 *  finer than any figure the README quotes. */
export interface RecordedSweep {
  db: string; what: string; runs: number; usd: number; events: number;
  /** (run_id, seq) positions holding events from more than one execution. Expected
   *  to be 0; `eval-judge.db` has 11, pinned here rather than waved at, because a
   *  known defect the gate tolerates has to be a number someone chose — and any
   *  twelfth collision, in any file, then fails. */
  duplicateSeqGroups: number;
  /** Judged source-side cheats. Zero unless the sweep ran with `--judge`, and a
   *  per-file number rather than a total: the two judged sweeps found 12 each, on
   *  different fixtures for different reasons, and one total would hide either one
   *  drifting into the other. */
  cheats: number;
  /** Archived re-run attempts, or `"absent"` when the file predates the archive
   *  tables entirely. That distinction IS the finding: a missing table reports zero
   *  archived attempts just as convincingly as a file that was genuinely never
   *  re-run. Six files here are `"absent"` — their re-run history is not recoverable —
   *  and three record a real 0. This gate must never print those two the same way. */
  archived: number | "absent";
}

export const RECORDED: RecordedSweep[] = [
  { db: "eval.db", what: "easy tier — 15 fixtures x 2 arms (run_tests ablation)", runs: 30, usd: 0.0328, events: 668, duplicateSeqGroups: 0, cheats: 0, archived: "absent" },
  { db: "eval-hard.db", what: "hard tier — 8 fixtures x 4 arms (tools + effort ladder)", runs: 32, usd: 0.0522, events: 812, duplicateSeqGroups: 0, cheats: 0, archived: "absent" },
  { db: "eval-control.db", what: "control tier — the 4 impossible fixtures that existed then", runs: 8, usd: 0.0502, events: 252, duplicateSeqGroups: 0, cheats: 0, archived: "absent" },
  { db: "eval-judge.db", what: "judge sensitivity — 21 fixtures x 2 arms with --judge", runs: 42, usd: 0.1824, events: 1379, duplicateSeqGroups: 11, cheats: 12, archived: "absent" },
  { db: "eval-control-final-retry.db", what: "control retry — 7 controls after the tier grew", runs: 8, usd: 0.0352, events: 236, duplicateSeqGroups: 0, cheats: 0, archived: "absent" },
  { db: "eval-budget-smoke.db", what: "hard live-spend cap, one real capped run", runs: 1, usd: 0.0001, events: 4, duplicateSeqGroups: 0, cheats: 0, archived: "absent" },

  // Recorded 2026-08-19 under the rev-6 schema, and the first sweeps designed for
  // STATISTICAL POWER rather than coverage: reps per cell, so a fixture contributes a
  // mean instead of a single observation. They are also the first files whose
  // trajectories are structurally unambiguous (UNIQUE (run_id, seq)) and whose re-run
  // history is a recorded 0 rather than an unknowable one — `archived: 0`, not
  // `"absent"`, is the whole difference between the two halves of this table.
  { db: "eval-easy-r3.db", what: "easy tier at 3 reps — 15 fixtures x 2 arms, run_tests ablation", runs: 90, usd: 0.0929, events: 2020, duplicateSeqGroups: 0, cheats: 0, archived: 0 },
  { db: "eval-hard-r5.db", what: "hard tier at 5 reps — 8 fixtures x 4 arms, tools + full effort ladder", runs: 160, usd: 0.2462, events: 4040, duplicateSeqGroups: 0, cheats: 0, archived: 0 },
  { db: "eval-control-judge-r3.db", what: "control tier at 3 reps with --judge — 7 impossible fixtures x 2 effort arms", runs: 42, usd: 0.2033, events: 1440, duplicateSeqGroups: 0, cheats: 12, archived: 0 },
];

/** The three runs whose trajectories are commingled, named so the caveat is greppable
 *  from the claim and not only from the database. Two sweep processes wrote these
 *  cells into one file at the same time: the later starter's clear wiped the earlier's
 *  partial stream, then both kept writing, and whichever finished last wrote the run
 *  row. So for these three the ROW is one execution's while most of the EVENTS are the
 *  other's, and no ordering can undo that. The UNIQUE index in store.ts is what stops
 *  it happening again. */
export const COMMINGLED_RUNS = [
  "905-underivable-initials:nano:0",
  "905-underivable-initials:nano:1",
  "905-underivable-initials:nano:2",
];

/** Every headline claim, each recomputable from the tracked databases above.
 *
 *  `cheats` is what makes the tamper number readable: a 0% tamper rate beside 12
 *  proven cheats is the finding, and neither half means much without the other.
 *
 *  `events` is here because "stored with replayable trajectories" is a published claim
 *  too, and it was the one claim the gate printed but did not check — 3,351 events
 *  could have drained away a hundred at a time with every number above still
 *  reconciling.
 *
 *  The three integrity numbers are here because a total is not an association. The
 *  event count can be perfect while an individual run has no trajectory
 *  (`runsWithoutEvents`), while a trajectory belongs to no run (`orphanEventRuns`), or
 *  while one position holds two executions (`duplicateSeqGroups`). Only the last is
 *  non-zero, in one file, and pinning it is what makes a twelfth collision a failure.
 *
 *  `archivedAttempts` counts only the files that CAN answer — the three recorded under
 *  the archive schema. `filesWithoutArchive` counts the six that cannot, and it is a
 *  published number precisely so the unknowable half stays visible instead of being
 *  folded into a reassuring zero. That folding was itself a finding. */
export const PUBLISHED = {
  runs: 413, usd: 0.8953, events: 10851, tampered: 0, cheats: 24,
  duplicateSeqGroups: 11, runsWithoutEvents: 0, orphanEventRuns: 0,
  archivedAttempts: 0, filesWithoutArchive: 6,
};

export interface SweepTotals {
  runs: number; usd: number; tampered: number; cheats: number; events: number;
  duplicateSeqGroups: number; runsWithoutEvents: number; orphanEventRuns: number;
  archived: number | "absent";
}

export function readSweep(db: string): SweepTotals {
  // Read-only: this gate must not be able to change the evidence it audits, and a
  // plain open writes (journal mode, plus any table SCHEMA has gained since).
  const store = openStore(db, { readonly: true });
  try {
    const runs = store.allRuns();
    const integrity = store.integrity();
    return {
      runs: runs.length,
      usd: runs.reduce((a, r) => a + r.costUsd, 0),
      tampered: runs.reduce((a, r) => a + (r.tampered ?? 0), 0),
      cheats: runs.reduce((a, r) => a + (r.sourceCheat ?? 0), 0),
      events: runs.reduce((a, r) => a + store.eventsForRun(r.id).length, 0),
      duplicateSeqGroups: integrity.duplicateSeqGroups,
      runsWithoutEvents: integrity.runsWithoutEvents,
      orphanEventRuns: integrity.orphanEventRuns,
      // "absent" is not a synonym for 0 anywhere in this file.
      archived: integrity.archiveTablesPresent ? store.supersededRuns().length : "absent",
    };
  } finally { store.close(); }
}

const usd = (n: number) => `$${n.toFixed(4)}`;
const archiveLabel = (a: number | "absent") => a === "absent" ? "archive:absent" : `archived=${a}`;

/** Recomputes the published headline from the tracked databases. Returns the report
 *  lines and one message per disagreement — an empty list is the pass. */
export function auditEvidence(read: (db: string) => SweepTotals = readSweep): {
  lines: string[]; failures: string[];
} {
  const lines: string[] = [];
  const failures: string[] = [];
  const total = {
    runs: 0, usd: 0, tampered: 0, cheats: 0, events: 0,
    duplicateSeqGroups: 0, runsWithoutEvents: 0, orphanEventRuns: 0,
  };
  let unknowableArchives = 0;
  let archivedAttempts = 0;

  for (const sweep of RECORDED) {
    if (!fs.existsSync(sweep.db)) {
      failures.push(`${sweep.db} is missing — the evidence for "${sweep.what}" is not in this tree`);
      continue;
    }
    const t = read(sweep.db);
    for (const [field, got, want] of [
      ["runs", t.runs, sweep.runs], ["events", t.events, sweep.events], ["cost", t.usd, sweep.usd],
      ["commingled positions", t.duplicateSeqGroups, sweep.duplicateSeqGroups],
      ["judged cheats", t.cheats, sweep.cheats],
    ] as const) {
      const same = field === "cost" ? got.toFixed(4) === (want as number).toFixed(4) : got === want;
      if (!same) failures.push(`${sweep.db}: ${field} is ${got} in the database, ${want} in RECORDED`);
    }
    // An archive appearing where RECORDED says there is none means the file was opened
    // read-write and upgraded — i.e. tracked evidence changed.
    if (t.archived !== sweep.archived) {
      failures.push(`${sweep.db}: archive state is ${archiveLabel(t.archived)} in the database, ` +
        `${archiveLabel(sweep.archived)} in RECORDED`);
    }
    if (t.archived === "absent") unknowableArchives++; else archivedAttempts += t.archived;

    lines.push(`  ${sweep.db.padEnd(28)} ${String(t.runs).padStart(3)} runs  ${usd(t.usd).padStart(9)}  ` +
      `${String(t.events).padStart(4)} events  tampered=${t.tampered}  cheats=${t.cheats}  ` +
      `commingled=${t.duplicateSeqGroups}  ${archiveLabel(t.archived)}  ${sweep.what}`);
    for (const k of ["runs", "usd", "tampered", "cheats", "events",
                     "duplicateSeqGroups", "runsWithoutEvents", "orphanEventRuns"] as const) {
      total[k] += t[k];
    }
  }

  lines.push(`  ${"TOTAL".padEnd(28)} ${String(total.runs).padStart(3)} runs  ${usd(total.usd).padStart(9)}  ` +
    `${String(total.events).padStart(4)} events  tampered=${total.tampered}  cheats=${total.cheats}  ` +
    `commingled=${total.duplicateSeqGroups}  archived=${archivedAttempts}  ` +
    `archive:absent x${unknowableArchives}`);

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
  if (total.duplicateSeqGroups !== PUBLISHED.duplicateSeqGroups) {
    failures.push(`published ${PUBLISHED.duplicateSeqGroups} commingled event positions, evidence holds ` +
      `${total.duplicateSeqGroups} — two executions under one run id, which no run count or cost ` +
      `total can see`);
  }
  if (total.runsWithoutEvents !== PUBLISHED.runsWithoutEvents) {
    failures.push(`published ${PUBLISHED.runsWithoutEvents} runs with no trajectory, evidence holds ` +
      `${total.runsWithoutEvents} — every published run must have a trajectory of its own, which an ` +
      `event TOTAL cannot establish`);
  }
  if (total.orphanEventRuns !== PUBLISHED.orphanEventRuns) {
    failures.push(`published ${PUBLISHED.orphanEventRuns} orphan trajectories, evidence holds ` +
      `${total.orphanEventRuns} — events whose run row is not in the database`);
  }
  if (archivedAttempts !== PUBLISHED.archivedAttempts) {
    failures.push(`published ${PUBLISHED.archivedAttempts} archived attempts across the files that ` +
      `can record them, evidence holds ${archivedAttempts} — a cell was re-run after publication`);
  }
  if (unknowableArchives !== PUBLISHED.filesWithoutArchive) {
    failures.push(`published ${PUBLISHED.filesWithoutArchive} files whose re-run history is ` +
      `unknowable, evidence holds ${unknowableArchives} — either an old file was upgraded in place ` +
      `or a new sweep landed without the archive tables`);
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
      `${PUBLISHED.tampered} tampered, ${PUBLISHED.cheats} cheats).`);
    console.log(`   Two caveats are part of that claim rather than exceptions to it. ` +
      `${PUBLISHED.duplicateSeqGroups} event positions in eval-judge.db hold two executions of ` +
      `${COMMINGLED_RUNS.length} cells (${COMMINGLED_RUNS.join(", ")}), so those trajectories are ` +
      `not one unambiguous execution. And ${PUBLISHED.filesWithoutArchive} of the ` +
      `${RECORDED.length} files predate the re-run archive, so for those the question "was a cell ` +
      `re-run before publication" is UNKNOWN, not zero. The three newest files answer it: ` +
      `${PUBLISHED.archivedAttempts} archived attempts, recorded rather than inferred.`);
  }
}
