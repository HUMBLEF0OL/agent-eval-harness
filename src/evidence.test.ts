import { describe, expect, it } from "vitest";
import { auditEvidence, PUBLISHED, RECORDED, type SweepTotals } from "./evidence.js";

/** A reader that returns exactly what RECORDED claims, so each test can perturb one
 *  number and nothing else. */
const asRecorded = (db: string): SweepTotals => {
  const s = RECORDED.find(r => r.db === db)!;
  return { runs: s.runs, usd: s.usd, tampered: 0, cheats: db === "eval-judge.db" ? 12 : 0, events: 0 };
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

  it("keeps the published totals equal to the sum of the recorded sweeps", () => {
    expect(RECORDED.reduce((a, r) => a + r.runs, 0)).toBe(PUBLISHED.runs);
    expect(RECORDED.reduce((a, r) => a + r.usd, 0).toFixed(4)).toBe(PUBLISHED.usd.toFixed(4));
  });
});
