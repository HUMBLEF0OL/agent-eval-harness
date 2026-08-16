import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openStore, type RunRow, type Store } from "./store.js";

let dir: string, store: Store;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aeh-db-"));
  store = openStore(path.join(dir, "t.db"));
});
afterEach(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const row = (over: Partial<RunRow> = {}): RunRow => ({
  id: "001:baseline:0", taskId: "001", variant: "baseline", provider: "openai",
  model: "gpt-5.6-terra", effort: "high", rep: 0,
  startedAt: "2026-08-16T10:00:00Z", endedAt: "2026-08-16T10:01:00Z",
  stopReason: "end_turn", steps: 4, passed: 1, tampered: 0, tamperDetail: null,
  sourceCheat: null, sourceCheatKind: null, sourceCheatEvidence: null,
  inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 4096,
  outputTokens: 900, reasoningTokens: 700, costUsd: 0.0123, wallMs: 60000, error: null,
  ...over,
});

describe("store", () => {
  it("round-trips a run row", () => {
    store.upsertRun(row());
    const [got] = store.allRuns();
    expect(got).toMatchObject({ id: "001:baseline:0", provider: "openai", reasoningTokens: 700 });
  });

  it("replaces rather than duplicates on re-run of the same cell", () => {
    store.upsertRun(row({ passed: 0 }));
    store.upsertRun(row({ passed: 1 }));
    const runs = store.allRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.passed).toBe(1);
  });

  it("replaces rather than interleaves the event stream on re-run of the same cell", () => {
    store.upsertRun(row());
    store.insertEvent("001:baseline:0", { seq: 0, type: "llm_call", payload: { attempt: 1 } });
    store.insertEvent("001:baseline:0", { seq: 1, type: "llm_response", payload: { attempt: 1 } });

    // Re-run of the same cell: the runner clears first, then writes the new stream.
    store.clearEvents("001:baseline:0");
    store.insertEvent("001:baseline:0", { seq: 0, type: "llm_call", payload: { attempt: 2 } });
    store.insertEvent("001:baseline:0", { seq: 1, type: "llm_response", payload: { attempt: 2 } });
    store.upsertRun(row());

    const evs = store.eventsForRun("001:baseline:0");
    expect(evs.map(e => e.seq)).toEqual([0, 1]);                        // not [0,0,1,1]
    expect(evs.map(e => JSON.parse(e.payload!).attempt)).toEqual([2, 2]); // no stale trajectory
  });

  it("clears only the target run's events", () => {
    store.upsertRun(row());
    store.upsertRun(row({ id: "002:baseline:0" }));
    store.insertEvent("001:baseline:0", { seq: 0, type: "llm_call" });
    store.insertEvent("002:baseline:0", { seq: 0, type: "llm_call" });
    store.clearEvents("001:baseline:0");
    expect(store.eventsForRun("001:baseline:0")).toHaveLength(0);
    expect(store.eventsForRun("002:baseline:0")).toHaveLength(1);
  });

  it("preserves NULL passed for refusals and errors", () => {
    store.upsertRun(row({ id: "x:y:0", stopReason: "refusal", passed: null }));
    expect(store.allRuns().find(r => r.id === "x:y:0")!.passed).toBeNull();
  });

  it("stores events with usage and returns them ordered by seq", () => {
    store.upsertRun(row());
    store.insertEvent("001:baseline:0", { seq: 1, type: "llm_response",
      payload: { stop: "end_turn" }, latencyMs: 900,
      usage: { inputTokens: 1, cacheWriteTokens: 2, cacheReadTokens: 3, outputTokens: 4, reasoningTokens: 5 } });
    store.insertEvent("001:baseline:0", { seq: 0, type: "llm_call", payload: { step: 0 } });

    const evs = store.eventsForRun("001:baseline:0");
    expect(evs.map(e => e.seq)).toEqual([0, 1]);
    expect(evs[1]).toMatchObject({ inTok: 1, cwTok: 2, crTok: 3, outTok: 4, rsnTok: 5 });
    expect(JSON.parse(evs[0]!.payload!)).toEqual({ step: 0 });
  });
});
