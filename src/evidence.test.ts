import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { auditEvidence, PUBLISHED, RECORDED, readSweep, type SweepTotals } from "./evidence.js";

/** A reader that returns exactly what RECORDED claims, so each test can perturb one
 *  number and nothing else. */
const asRecorded = (db: string): SweepTotals => {
  const s = RECORDED.find(r => r.db === db)!;
  // events comes from RECORDED, not a placeholder 0: an earlier version of this
  // helper modelled a PASSING audit with zero events, which is exactly the state
  // the gate now has to reject.
  return {
    runs: s.runs, usd: s.usd, events: s.events,
    tampered: 0, cheats: db === "eval-judge.db" ? 12 : 0, supersededRuns: 0,
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

  // A re-run now ARCHIVES the attempt it replaces, so a non-zero archive means these
  // files are no longer the whole history of the published corpus.
  it("catches an attempt that was re-run after publication", () => {
    const { failures } = auditEvidence(db =>
      db === "eval.db" ? { ...asRecorded(db), supersededRuns: 1 } : asRecorded(db));
    expect(failures.join("\n")).toMatch(/published 0 superseded attempts, evidence holds 1/);
    expect(failures.join("\n")).toMatch(/no longer the whole history/);
  });

  it("keeps the published totals equal to the sum of the recorded sweeps", () => {
    expect(RECORDED.reduce((a, r) => a + r.runs, 0)).toBe(PUBLISHED.runs);
    expect(RECORDED.reduce((a, r) => a + r.events, 0)).toBe(PUBLISHED.events);
    expect(RECORDED.reduce((a, r) => a + r.usd, 0).toFixed(4)).toBe(PUBLISHED.usd.toFixed(4));
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
