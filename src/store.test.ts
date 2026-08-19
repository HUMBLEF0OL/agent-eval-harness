import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
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

    // Re-run of the same cell: the runner supersedes first, then writes the new stream.
    expect(store.supersede("001:baseline:0")).toBe(1);
    store.insertEvent("001:baseline:0", { seq: 0, type: "llm_call", payload: { attempt: 2 } });
    store.insertEvent("001:baseline:0", { seq: 1, type: "llm_response", payload: { attempt: 2 } });
    store.upsertRun(row());

    const evs = store.eventsForRun("001:baseline:0");
    expect(evs.map(e => e.seq)).toEqual([0, 1]);                        // not [0,0,1,1]
    expect(evs.map(e => JSON.parse(e.payload!).attempt)).toEqual([2, 2]); // no stale trajectory
  });

  // The provenance half: replacing the LIVE row is what the metrics need, and losing
  // the attempt it replaced is what made the database a snapshot rather than a record.
  it("keeps the superseded attempt, row and trajectory, instead of dropping it", () => {
    store.upsertRun(row({ passed: 0, stopReason: "max_steps" }));
    store.insertEvent("001:baseline:0", { seq: 0, type: "llm_call", payload: { attempt: 1 } });
    store.insertEvent("001:baseline:0", { seq: 1, type: "llm_response", payload: { attempt: 1 } });

    store.supersede("001:baseline:0");
    store.upsertRun(row({ passed: 1 }));
    store.insertEvent("001:baseline:0", { seq: 0, type: "llm_call", payload: { attempt: 2 } });

    // Live view: exactly the latest attempt, so pass rates and costs are unaffected.
    expect(store.allRuns()).toHaveLength(1);
    expect(store.allRuns()[0]!.passed).toBe(1);
    expect(store.eventsForRun("001:baseline:0")).toHaveLength(1);

    // Archive: the earlier attempt, in full.
    const [old] = store.supersededRuns();
    expect(old).toMatchObject({ attempt: 1, id: "001:baseline:0", passed: 0, stopReason: "max_steps" });
    const oldEvents = store.supersededEventsForRun("001:baseline:0", 1);
    expect(oldEvents.map(e => e.seq)).toEqual([0, 1]);
    expect(oldEvents.map(e => JSON.parse(e.payload!).attempt)).toEqual([1, 1]);
  });

  it("numbers repeated re-runs of the same cell in order", () => {
    store.upsertRun(row({ passed: 0 }));
    expect(store.supersede("001:baseline:0")).toBe(1);
    store.upsertRun(row({ passed: 1 }));
    expect(store.supersede("001:baseline:0")).toBe(2);
    store.upsertRun(row({ passed: 0 }));
    expect(store.supersededRuns().map(r => [r.attempt, r.passed])).toEqual([[1, 0], [2, 1]]);
  });

  it("reports 0 and archives nothing when the cell has never run", () => {
    expect(store.supersede("nothing:here:0")).toBe(0);
    expect(store.supersededRuns()).toEqual([]);
  });

  it("supersedes only the target run", () => {
    store.upsertRun(row());
    store.upsertRun(row({ id: "002:baseline:0" }));
    store.insertEvent("001:baseline:0", { seq: 0, type: "llm_call" });
    store.insertEvent("002:baseline:0", { seq: 0, type: "llm_call" });
    store.supersede("001:baseline:0");
    expect(store.eventsForRun("001:baseline:0")).toHaveLength(0);
    expect(store.eventsForRun("002:baseline:0")).toHaveLength(1);
    expect(store.supersededRuns().map(r => r.id)).toEqual(["001:baseline:0"]);
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

  // The reason read-only exists: the six published sweep databases are tracked
  // evidence. A plain open sets a journal mode and creates any table SCHEMA has
  // gained since — both of which write to the file the report is meant to summarise.
  it("cannot write, and does not touch a byte, when opened read-only", () => {
    const p = path.join(dir, "ro.db");
    const w = openStore(p);
    w.upsertRun(row());
    w.insertEvent("001:baseline:0", { seq: 0, type: "llm_call" });
    w.close();

    const before = fs.readFileSync(p);
    const r = openStore(p, { readonly: true });
    expect(r.allRuns()).toHaveLength(1);
    expect(r.eventsForRun("001:baseline:0")).toHaveLength(1);
    expect(() => r.upsertRun(row({ id: "x:y:0" }))).toThrow();
    expect(() => r.supersede("001:baseline:0")).toThrow(/read-only/);
    r.close();
    expect(fs.readFileSync(p).equals(before)).toBe(true);
  });

  // A database written before the superseded_* tables existed is READ, never
  // migrated — migrating would rewrite the tracked evidence files.
  it("reads a database that predates the archive tables without failing", () => {
    const p = path.join(dir, "legacy.db");
    const legacy = new Database(p);
    legacy.exec(`CREATE TABLE runs (
      id TEXT PRIMARY KEY, task_id TEXT, variant TEXT, provider TEXT, model TEXT, effort TEXT,
      rep INTEGER, started_at TEXT, ended_at TEXT, stop_reason TEXT, steps INTEGER,
      passed INTEGER, tampered INTEGER, tamper_detail TEXT, source_cheat INTEGER,
      source_cheat_kind TEXT, source_cheat_evidence TEXT, input_tokens INTEGER,
      cache_write_tokens INTEGER, cache_read_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, cost_usd REAL, wall_ms INTEGER, error TEXT);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, seq INTEGER,
      type TEXT, name TEXT, payload TEXT, in_tok INTEGER, cw_tok INTEGER, cr_tok INTEGER,
      out_tok INTEGER, rsn_tok INTEGER, latency_ms INTEGER, ts TEXT);
      INSERT INTO runs (id, task_id, variant, provider, model, effort, rep, started_at, cost_usd)
      VALUES ('001:baseline:0', '001', 'baseline', 'openai', 'gpt-5-nano', 'high', 0, '', 0.01);`);
    legacy.close();

    const r = openStore(p, { readonly: true });
    try {
      expect(r.allRuns()).toHaveLength(1);
      expect(r.supersededRuns()).toEqual([]);
      expect(r.supersededEventsForRun("001:baseline:0", 1)).toEqual([]);
    } finally { r.close(); }
  });
});
