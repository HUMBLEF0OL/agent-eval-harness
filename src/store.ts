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

/** A run row that has been replaced by a re-run. `attempt` counts from 1 in the
 *  order the attempts were superseded, so the highest number is the most recent
 *  thing the live `runs` row replaced. */
export type SupersededRun = RunRow & { attempt: number };

const RUN_COLUMNS = `
  id TEXT, task_id TEXT, variant TEXT,
  provider TEXT, model TEXT, effort TEXT, rep INTEGER,
  started_at TEXT, ended_at TEXT,
  stop_reason TEXT, steps INTEGER, passed INTEGER, tampered INTEGER, tamper_detail TEXT,
  source_cheat INTEGER, source_cheat_kind TEXT, source_cheat_evidence TEXT,
  input_tokens INTEGER, cache_write_tokens INTEGER, cache_read_tokens INTEGER,
  output_tokens INTEGER, reasoning_tokens INTEGER,
  cost_usd REAL, wall_ms INTEGER, error TEXT`;

// superseded_runs/superseded_events mirror runs/events column-for-column with an
// `attempt` prepended, which is what lets supersede() archive with
// `INSERT INTO superseded_x SELECT ?, * FROM x` instead of restating 25 columns.
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
CREATE TABLE IF NOT EXISTS superseded_runs (attempt INTEGER NOT NULL, ${RUN_COLUMNS});
CREATE TABLE IF NOT EXISTS superseded_events (
  attempt INTEGER NOT NULL, id INTEGER,
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, name TEXT, payload TEXT,
  in_tok INTEGER, cw_tok INTEGER, cr_tok INTEGER, out_tok INTEGER, rsn_tok INTEGER,
  latency_ms INTEGER, ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_runs_variant ON runs(variant, task_id);
CREATE INDEX IF NOT EXISTS idx_superseded_events_run ON superseded_events(run_id, attempt, seq);
`;

export interface Store {
  upsertRun(r: RunRow): void;
  insertEvent(runId: string, e: EventInput): void;
  /** Archives a cell's current row and trajectory into the superseded_* tables and
   *  empties its live event stream. The runner calls this BEFORE re-running a cell:
   *  without the clear, the second run interleaves with the first under duplicate
   *  seq values; without the archive, the first attempt is simply gone.
   *  Returns the attempt number written, or 0 when there was nothing to archive. */
  supersede(runId: string): number;
  allRuns(): RunRow[];
  eventsForRun(runId: string): StoredEvent[];
  /** Every attempt a re-run replaced. Empty for a database written before the
   *  superseded_* tables existed — those are read, never migrated. */
  supersededRuns(): SupersededRun[];
  supersededEventsForRun(runId: string, attempt: number): StoredEvent[];
  close(): void;
}

const RUN_SELECT = `
    id, task_id AS taskId, variant, provider, model, effort, rep,
    started_at AS startedAt, ended_at AS endedAt, stop_reason AS stopReason, steps,
    passed, tampered, tamper_detail AS tamperDetail,
    source_cheat AS sourceCheat, source_cheat_kind AS sourceCheatKind,
    source_cheat_evidence AS sourceCheatEvidence,
    input_tokens AS inputTokens, cache_write_tokens AS cacheWriteTokens,
    cache_read_tokens AS cacheReadTokens, output_tokens AS outputTokens,
    reasoning_tokens AS reasoningTokens, cost_usd AS costUsd, wall_ms AS wallMs, error`;

const EVENT_SELECT = `
    seq, type, name, payload, in_tok AS inTok, cw_tok AS cwTok, cr_tok AS crTok,
    out_tok AS outTok, rsn_tok AS rsnTok, latency_ms AS latencyMs, ts`;

export interface StoreOptions {
  /** Opens without creating, without setting a journal mode, and without running
   *  SCHEMA. The published sweep databases are TRACKED EVIDENCE, and every one of
   *  those three writes to the file: `CREATE TABLE IF NOT EXISTS` for a table added
   *  later, `journal_mode` for the header. `npm run report` and `npm run evidence`
   *  read them, so they must not be able to change a byte of them. */
  readonly?: boolean;
}

export function openStore(dbPath: string, opts: StoreOptions = {}): Store {
  const db = new Database(dbPath, { readonly: opts.readonly === true });
  if (!opts.readonly) {
    db.pragma("journal_mode = WAL");   // CONCURRENCY=4 writers
    db.exec(SCHEMA);
  }

  /** A database written before superseded_* existed has no such table, and it is
   *  read rather than migrated — so a query against it must return empty instead
   *  of throwing at prepare time. */
  const hasTable = (name: string) => db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;

  const ins = db.prepare(`INSERT OR REPLACE INTO runs VALUES (
    @id,@taskId,@variant,@provider,@model,@effort,@rep,@startedAt,@endedAt,
    @stopReason,@steps,@passed,@tampered,@tamperDetail,
    @sourceCheat,@sourceCheatKind,@sourceCheatEvidence,
    @inputTokens,@cacheWriteTokens,@cacheReadTokens,@outputTokens,@reasoningTokens,
    @costUsd,@wallMs,@error)`);

  const insEv = db.prepare(`INSERT INTO events
    (run_id,seq,type,name,payload,in_tok,cw_tok,cr_tok,out_tok,rsn_tok,latency_ms,ts)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

  const selRuns = db.prepare(`SELECT ${RUN_SELECT} FROM runs`);
  const selEvents = db.prepare(`SELECT ${EVENT_SELECT} FROM events WHERE run_id = ? ORDER BY seq`);

  // Prepared on demand: these three statements name tables that a pre-existing
  // database may not have, and prepare() throws on an unknown table.
  const supersede = opts.readonly ? undefined : db.transaction((runId: string): number => {
    const attempt = (db.prepare(
      `SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM superseded_runs WHERE id = ?`)
      .get(runId) as { n: number }).n;
    const runs = db.prepare(`INSERT INTO superseded_runs SELECT ?, * FROM runs WHERE id = ?`)
      .run(attempt, runId).changes;
    const events = db.prepare(`INSERT INTO superseded_events SELECT ?, * FROM events WHERE run_id = ?`)
      .run(attempt, runId).changes;
    db.prepare(`DELETE FROM events WHERE run_id = ?`).run(runId);
    return runs + events > 0 ? attempt : 0;
  });

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
    supersede: (runId) => {
      if (!supersede) throw new Error(`store opened read-only: cannot supersede ${runId}`);
      return supersede(runId);
    },
    allRuns: () => selRuns.all() as RunRow[],
    eventsForRun: (runId) => selEvents.all(runId) as StoredEvent[],
    supersededRuns: () => hasTable("superseded_runs")
      ? db.prepare(`SELECT attempt, ${RUN_SELECT} FROM superseded_runs ORDER BY id, attempt`)
          .all() as SupersededRun[]
      : [],
    supersededEventsForRun: (runId, attempt) => hasTable("superseded_events")
      ? db.prepare(`SELECT ${EVENT_SELECT} FROM superseded_events
                    WHERE run_id = ? AND attempt = ? ORDER BY seq`)
          .all(runId, attempt) as StoredEvent[]
      : [],
    close: () => db.close(),
  };
}
