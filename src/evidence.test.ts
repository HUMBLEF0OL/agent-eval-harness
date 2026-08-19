import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import {
  auditEvidence, COMMINGLED_RUNS, PUBLISHED, RECORDED, readSweep, type SweepTotals,
} from "./evidence.js";

/** A reader that returns exactly what RECORDED claims, so each test can perturb one
 *  number and nothing else. */
const asRecorded = (db: string): SweepTotals => {
  const s = RECORDED.find(r => r.db === db)!;
  // events comes from RECORDED, not a placeholder 0: an earlier version of this
  // helper modelled a PASSING audit with zero events, which is exactly the state
  // the gate now has to reject.
  return {
    runs: s.runs, usd: s.usd, events: s.events,
    tampered: 0, cheats: db === "eval-judge.db" ? 12 : 0,
    duplicateSeqGroups: s.duplicateSeqGroups, runsWithoutEvents: 0, orphanEventRuns: 0,
    archived: s.archived,
  };
};

describe("auditEvidence", () => {
  it("passes when every database matches the published claim", () => {
    expect(auditEvidence(asRecorded).failures).toEqual([]);
  });

  // The point of the gate: the published headline and the databases in the tree can
  // drift apart, and silence is the failure mode that matters. One missing run must
  // break BOTH the per-sweep check and the 121-run total.
  it("catches a sweep that no longer holds what the README says it holds", () => {
    const { failures } = auditEvidence(db =>
      db === "eval.db" ? { ...asRecorded(db), runs: 29 } : asRecorded(db));
    expect(failures).toHaveLength(2);
    expect(failures.join("\n")).toMatch(/eval\.db: runs is 29/);
    expect(failures.join("\n")).toMatch(/published 121 runs, evidence holds 120/);
  });

  it("catches a cost that drifts by a hundredth of a cent", () => {
    const { failures } = auditEvidence(db =>
      db === "eval-judge.db" ? { ...asRecorded(db), usd: 0.1825 } : asRecorded(db));
    expect(failures.join("\n")).toMatch(/eval-judge\.db: cost is 0\.1825 in the database/);
  });

  // Zero tampering is only a finding beside the twelve proven cheats: losing either
  // half of that pair leaves the README's sharpest claim unsupported.
  it("catches a lost tamper or cheat count", () => {
    const { failures } = auditEvidence(db =>
      ({ ...asRecorded(db), cheats: 0, tampered: db === "eval.db" ? 1 : 0 }));
    expect(failures.join("\n")).toMatch(/published 0 tampered runs, evidence holds 1/);
    expect(failures.join("\n")).toMatch(/published 12 judged cheats, evidence holds 0/);
  });

  // The High finding this closes: 3,351 events were PRINTED but never checked, so a
  // trajectory could vanish with every other total still reconciling.
  it("catches trajectories that have drained away", () => {
    const { failures } = auditEvidence(db =>
      db === "eval-judge.db" ? { ...asRecorded(db), events: 1279 } : asRecorded(db));
    expect(failures.join("\n")).toMatch(/eval-judge\.db: events is 1279 in the database, 1379/);
    expect(failures.join("\n")).toMatch(/published 3351 trajectory events, evidence holds 3251/);
  });

  it("catches a corpus that has silently lost every trajectory", () => {
    // The literal shape of the old test helper: all six databases with no events at
    // all, and every run count, cost, tamper and cheat total still perfect.
    const { failures } = auditEvidence(db => ({ ...asRecorded(db), events: 0 }));
    expect(failures.length).toBe(RECORDED.length + 1);   // one per sweep, plus the total
  });

  // Every published file predates the archive tables, so "no archived attempts" is
  // the ABSENCE OF A PLACE to record them, not a fact about re-runs. The gate has to
  // report those two differently — publishing the first as the second was a finding.
  it("reports an absent archive as unknowable rather than as zero", () => {
    expect(RECORDED.every(r => r.archived === "absent")).toBe(true);
    const { lines, failures } = auditEvidence(asRecorded);
    expect(failures).toEqual([]);
    expect(lines.join("\n")).toContain("archive:absent");
    expect(lines.join("\n")).not.toMatch(/archived=0/);
    expect(lines[lines.length - 1]).toContain(`archive:absent x${RECORDED.length}`);
  });

  it("catches an archive appearing where the corpus is supposed to have none", () => {
    // Which is how a tracked database gets upgraded behind your back: something
    // opened it read-write, and the schema exec created the tables.
    const { failures } = auditEvidence(db =>
      db === "eval.db" ? { ...asRecorded(db), archived: 0 } : asRecorded(db));
    expect(failures.join("\n")).toMatch(/eval\.db: archive state is archived=0 .*archive:absent in RECORDED/);
  });

  // Commingled trajectories: two executions under one run id. No run count and no
  // cost total can see this, which is why it is its own published number.
  it("catches a new commingled trajectory, and holds the known ones to their count", () => {
    expect(RECORDED.find(r => r.db === "eval-judge.db")!.duplicateSeqGroups).toBe(11);
    expect(PUBLISHED.duplicateSeqGroups).toBe(11);
    expect(COMMINGLED_RUNS).toHaveLength(3);

    const { failures } = auditEvidence(db =>
      db === "eval.db" ? { ...asRecorded(db), duplicateSeqGroups: 1 } : asRecorded(db));
    expect(failures.join("\n")).toMatch(/eval\.db: commingled positions is 1 in the database, 0/);
    expect(failures.join("\n")).toMatch(/published 11 commingled event positions, evidence holds 12/);
  });

  it("catches a twelfth collision inside the file that already has eleven", () => {
    const { failures } = auditEvidence(db =>
      db === "eval-judge.db" ? { ...asRecorded(db), duplicateSeqGroups: 12 } : asRecorded(db));
    expect(failures.join("\n")).toMatch(/eval-judge\.db: commingled positions is 12 in the database, 11/);
  });

  // The per-run property the previous round left ungated: every published run must
  // have a trajectory of its own, which an event TOTAL cannot establish.
  it("catches a run with no trajectory, and a trajectory with no run", () => {
    const noEvents = auditEvidence(db =>
      db === "eval-hard.db" ? { ...asRecorded(db), runsWithoutEvents: 2 } : asRecorded(db));
    expect(noEvents.failures.join("\n")).toMatch(/published 0 runs with no trajectory, evidence holds 2/);

    const orphans = auditEvidence(db =>
      db === "eval-hard.db" ? { ...asRecorded(db), orphanEventRuns: 1 } : asRecorded(db));
    expect(orphans.failures.join("\n")).toMatch(/published 0 orphan trajectories, evidence holds 1/);
  });

  it("keeps the published totals equal to the sum of the recorded sweeps", () => {
    expect(RECORDED.reduce((a, r) => a + r.runs, 0)).toBe(PUBLISHED.runs);
    expect(RECORDED.reduce((a, r) => a + r.events, 0)).toBe(PUBLISHED.events);
    expect(RECORDED.reduce((a, r) => a + r.duplicateSeqGroups, 0)).toBe(PUBLISHED.duplicateSeqGroups);
    expect(RECORDED.reduce((a, r) => a + r.usd, 0).toFixed(4)).toBe(PUBLISHED.usd.toFixed(4));
  });

  // Against the real files, not an injected reader: the numbers RECORDED claims for
  // the commingled database are what a reader of that database actually finds.
  it("reads the known integrity state out of the real eval-judge.db", () => {
    const t = readSweep("eval-judge.db");
    expect(t.duplicateSeqGroups).toBe(11);
    expect(t.runsWithoutEvents).toBe(0);
    expect(t.orphanEventRuns).toBe(0);
    expect(t.archived).toBe("absent");
  });

  // Reading the evidence must not be able to change it. This drives the real
  // readSweep against a real tracked database rather than an injected reader.
  it("leaves the database it audits byte-identical", () => {
    const db = "eval-budget-smoke.db";
    const before = fs.readFileSync(db);
    const totals = readSweep(db);
    expect(totals.runs).toBe(1);
    expect(totals.events).toBe(4);
    expect(fs.readFileSync(db).equals(before)).toBe(true);
  });
});
