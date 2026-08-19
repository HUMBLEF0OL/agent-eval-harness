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
-- UNIQUE, not merely indexed. Three published trajectories (905-underivable-initials
-- reps 0-2 in eval-judge.db) hold events from TWO executions of the same cell under
-- one run_id, because two sweep processes wrote the same database at the same time:
-- the later starter's clear wiped the earlier's partial stream, then both kept
-- writing. Nothing in the schema objected. Now the second writer fails on its first
-- colliding seq instead of silently interleaving. It also makes reopening one of
-- those three databases READ-WRITE impossible, which is correct — writing more into
-- an already-ambiguous stream can only compound it (see openStore's error).
-- Named idx_events_unique, NOT idx_events_run: the older non-unique index of that
-- name already exists in every database written before this, and IF NOT EXISTS
-- matches on the NAME — reusing it would have made this line a silent no-op
-- exactly where the guard is most needed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_runs_variant ON runs(variant, task_id);
CREATE INDEX IF NOT EXISTS idx_superseded_events_run ON superseded_events(run_id, attempt, seq);
`;

export interface Store {
  upsertRun(r: RunRow): void;
  insertEvent(runId: string, e: EventInput): void;
  /** Archives a cell's current row and trajectory into the superseded_* tables, then
   *  removes BOTH from the live view. The runner calls this before re-running a cell:
   *  without the clear the second run interleaves with the first under duplicate seq
   *  values, and without the archive the first attempt is simply gone.
   *
   *  The row goes too, not just the events. A re-run writes its new row only when it
   *  finishes, so leaving the old row behind meant that for the whole duration of the
   *  new attempt — and forever, if it crashed — the live view paired OLD metrics with
   *  the new attempt's partial events. Removing both makes an in-flight re-run look
   *  exactly like a cell that has not run yet, which is a state everything downstream
   *  already handles, and the displaced attempt stays readable in the archive.
   *  Returns the attempt number written, or 0 when there was nothing to archive. */
  supersede(runId: string): number;
  allRuns(): RunRow[];
  eventsForRun(runId: string): StoredEvent[];
  /** Every attempt a re-run replaced. Empty for a database written before the
   *  superseded_* tables existed — those are read, never migrated. Callers that need
   *  to tell "no re-runs" apart from "this file cannot say" must read
   *  `integrity().archiveTablesPresent`, NOT the length of this array. */
  supersededRuns(): SupersededRun[];
  /** Structural facts about the stored corpus, for the evidence gate. Counting runs
   *  and summing costs cannot see any of these: a trajectory can be commingled with
   *  another execution's, a run can have no trajectory at all, and events can point
   *  at a run row that is not there. */
  integrity(): StoreIntegrity;
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

export interface StoreIntegrity {
  /** (run_id, seq) pairs holding more than one event: two executions commingled
   *  under one run id. Structurally impossible in a database created after the
   *  UNIQUE index above; present in one published database, which is why this is a
   *  measured number rather than an assumption. */
  duplicateSeqGroups: number;
  /** Run rows with no trajectory at all. The event TOTAL can reconcile while an
   *  individual run's stream has gone. */
  runsWithoutEvents: number;
  /** Distinct run_ids in events with no matching run row. */
  orphanEventRuns: number;
  /** False for a database written before the archive tables existed. In that case
   *  "zero superseded attempts" is not a fact about re-runs, it is the absence of a
   *  place to record them, and the evidence gate must not report the two alike. */
  archiveTablesPresent: boolean;
}

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
    try {
      // In a transaction: db.exec runs the statements one at a time, so a database
      // that fails on the UNIQUE index below would otherwise KEEP the tables created
      // before it — the open is refused, and the file has still been changed. For a
      // tracked evidence file that is the whole thing we are trying to prevent.
      db.transaction(() => db.exec(SCHEMA))();
    } catch (e) {
      db.close();
      // The one failure worth translating: the UNIQUE index cannot be built over a
      // database whose events are already commingled (eval-judge.db is such a file).
      // The raw message names a constraint nobody has heard of.
      if (/UNIQUE constraint failed: events/.test((e as Error).message)) {
        throw new Error(
          `${dbPath} already holds two executions under one run id — it has duplicate ` +
          `(run_id, seq) events, so the UNIQUE index this schema requires cannot be built. ` +
          `That database is evidence of an interleaved write and must not be written to ` +
          `again; open it read-only, or sweep into a new file. ` +
          `Original: ${(e as Error).message}`);
      }
      throw e;
    }
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
  // ORDER BY id, not seq. For every stream written by one execution the two are
  // identical, because events are inserted in emit order. They differ only where a
  // stream is commingled, and there `ORDER BY seq` interleaves two executions with
  // ties broken arbitrarily — the same database could replay differently twice.
  // Insertion order is always well-defined, and a seq that goes BACKWARDS in it marks
  // the boundary between executions, which is what makes the two separable at all.
  const selEvents = db.prepare(`SELECT ${EVENT_SELECT} FROM events WHERE run_id = ? ORDER BY id`);

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
    db.prepare(`DELETE FROM runs WHERE id = ?`).run(runId);
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
                    WHERE run_id = ? AND attempt = ? ORDER BY id`)
          .all(runId, attempt) as StoredEvent[]
      : [],
    integrity: () => ({
      duplicateSeqGroups: (db.prepare(
        `SELECT COUNT(*) AS c FROM (
           SELECT run_id FROM events GROUP BY run_id, seq HAVING COUNT(*) > 1)`)
        .get() as { c: number }).c,
      runsWithoutEvents: (db.prepare(
        `SELECT COUNT(*) AS c FROM runs r
         WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.run_id = r.id)`)
        .get() as { c: number }).c,
      orphanEventRuns: (db.prepare(
        `SELECT COUNT(DISTINCT run_id) AS c FROM events e
         WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = e.run_id)`)
        .get() as { c: number }).c,
      archiveTablesPresent: hasTable("superseded_runs") && hasTable("superseded_events"),
    }),
    close: () => db.close(),
  };
}
