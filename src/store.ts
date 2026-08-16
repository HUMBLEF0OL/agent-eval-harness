import Database from "better-sqlite3";
import type { EventInput, ProviderId } from "./types.js";

export interface RunRow {
  id: string; taskId: string; variant: string; provider: ProviderId;
  model: string; effort: string; rep: number;
  startedAt: string; endedAt: string | null;
  stopReason: string | null; steps: number | null;
  passed: number | null; tampered: number | null; tamperDetail: string | null;
  sourceCheat: number | null; sourceCheatKind: string | null; sourceCheatEvidence: string | null;
  inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number;
  outputTokens: number; reasoningTokens: number;
  costUsd: number; wallMs: number; error: string | null;
}

export interface StoredEvent {
  seq: number; type: string; name: string | null; payload: string | null;
  inTok: number | null; cwTok: number | null; crTok: number | null;
  outTok: number | null; rsnTok: number | null; latencyMs: number | null; ts: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, variant TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, rep INTEGER NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT,
  stop_reason TEXT, steps INTEGER, passed INTEGER, tampered INTEGER, tamper_detail TEXT,
  source_cheat INTEGER, source_cheat_kind TEXT, source_cheat_evidence TEXT,
  input_tokens INTEGER, cache_write_tokens INTEGER, cache_read_tokens INTEGER,
  output_tokens INTEGER, reasoning_tokens INTEGER,
  cost_usd REAL, wall_ms INTEGER, error TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, name TEXT, payload TEXT,
  in_tok INTEGER, cw_tok INTEGER, cr_tok INTEGER, out_tok INTEGER, rsn_tok INTEGER,
  latency_ms INTEGER, ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_runs_variant ON runs(variant, task_id);
`;

export interface Store {
  upsertRun(r: RunRow): void;
  insertEvent(runId: string, e: EventInput): void;
  allRuns(): RunRow[];
  eventsForRun(runId: string): StoredEvent[];
  close(): void;
}

export function openStore(dbPath: string): Store {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");   // CONCURRENCY=4 writers
  db.exec(SCHEMA);

  const ins = db.prepare(`INSERT OR REPLACE INTO runs VALUES (
    @id,@taskId,@variant,@provider,@model,@effort,@rep,@startedAt,@endedAt,
    @stopReason,@steps,@passed,@tampered,@tamperDetail,
    @sourceCheat,@sourceCheatKind,@sourceCheatEvidence,
    @inputTokens,@cacheWriteTokens,@cacheReadTokens,@outputTokens,@reasoningTokens,
    @costUsd,@wallMs,@error)`);

  const insEv = db.prepare(`INSERT INTO events
    (run_id,seq,type,name,payload,in_tok,cw_tok,cr_tok,out_tok,rsn_tok,latency_ms,ts)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

  const selRuns = db.prepare(`SELECT
    id, task_id AS taskId, variant, provider, model, effort, rep,
    started_at AS startedAt, ended_at AS endedAt, stop_reason AS stopReason, steps,
    passed, tampered, tamper_detail AS tamperDetail,
    source_cheat AS sourceCheat, source_cheat_kind AS sourceCheatKind,
    source_cheat_evidence AS sourceCheatEvidence,
    input_tokens AS inputTokens, cache_write_tokens AS cacheWriteTokens,
    cache_read_tokens AS cacheReadTokens, output_tokens AS outputTokens,
    reasoning_tokens AS reasoningTokens, cost_usd AS costUsd, wall_ms AS wallMs, error
    FROM runs`);

  const selEvents = db.prepare(`SELECT
    seq, type, name, payload, in_tok AS inTok, cw_tok AS cwTok, cr_tok AS crTok,
    out_tok AS outTok, rsn_tok AS rsnTok, latency_ms AS latencyMs, ts
    FROM events WHERE run_id = ? ORDER BY seq`);

  return {
    upsertRun: (r) => { ins.run(r as unknown as Record<string, unknown>); },
    insertEvent: (runId, e) => {
      const u = e.usage;
      insEv.run(runId, e.seq, e.type, e.name ?? null,
        e.payload === undefined ? null : JSON.stringify(e.payload),
        u?.inputTokens ?? null, u?.cacheWriteTokens ?? null, u?.cacheReadTokens ?? null,
        u?.outputTokens ?? null, u?.reasoningTokens ?? null,
        e.latencyMs ?? null, new Date().toISOString());
    },
    allRuns: () => selRuns.all() as RunRow[],
    eventsForRun: (runId) => selEvents.all(runId) as StoredEvent[],
    close: () => db.close(),
  };
}
