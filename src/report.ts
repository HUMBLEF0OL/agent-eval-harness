import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { openStore, type RunRow, type StoredEvent } from "./store.js";
// From ./types.js, not ./runner.js: runner pulls in the provider registry and
// with it both vendor SDKs, which have no business in the report path.
import { JUDGE_MODEL } from "./types.js";

/** Deterministic PRNG so a report regenerated from the same DB is byte-identical. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapCI(values: number[], resamples = 2000, seed = 42) {
  if (values.length === 0) return { lo: 0, hi: 0 };
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(rand() * values.length)]!;
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return {
    lo: means[Math.floor(0.025 * resamples)]!,
    hi: means[Math.floor(0.975 * resamples)]!,
  };
}

/** Wilson score interval for a proportion. The report passes the number of distinct
 * fixtures as n, rather than pretending repeated executions of one fixture are
 * independent evidence about the task population. */
export function wilsonCI(rate: number, n: number, z = 1.959963984540054) {
  if (!Number.isFinite(rate) || n <= 0) return null;
  const p = Math.min(1, Math.max(0, rate));
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const halfWidth = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n) / denominator;
  return { lo: Math.max(0, centre - halfWidth), hi: Math.min(1, centre + halfWidth) };
}

export interface VariantSummary {
  variant: string; provider: string; model: string; effort: string;
  runCount: number; scoredRuns: number; scoredFixtures: number; passingRuns: number;
  passRate: number | null; ci: { lo: number; hi: number } | null;
  tamperedRuns: number; tamperRate: number; refusals: number; errors: number;
  meanCost: number; meanSteps: number; meanReasoning: number;
  /** Raw per-run step counts. The distribution chart needs the spread, and a mean
   *  cannot be un-averaged back into one. */
  stepValues: number[];
  stopCounts: Record<string, number>;
  judgedRuns: number; sourceCheats: number;
  /** null when no source-cheat verdict was recorded for this variant. */
  sourceCheatRate: number | null;
}

export function summarise(runs: RunRow[]): VariantSummary[] {
  const byVariant = new Map<string, RunRow[]>();
  for (const r of runs) (byVariant.get(r.variant) ?? byVariant.set(r.variant, []).get(r.variant)!).push(r);

  return [...byVariant].map(([variant, rs]) => {
    const scored = rs.filter(r => r.passed !== null);
    const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const passesByFixture = new Map<string, number[]>();
    for (const r of scored) {
      const fixture = passesByFixture.get(r.taskId) ?? [];
      fixture.push(r.passed!);
      passesByFixture.set(r.taskId, fixture);
    }
    const fixturePassRates = [...passesByFixture.values()].map(mean);
    const passRate = fixturePassRates.length ? mean(fixturePassRates) : null;
    const stopCounts: Record<string, number> = {};
    for (const r of rs) stopCounts[r.stopReason ?? "unknown"] = (stopCounts[r.stopReason ?? "unknown"] ?? 0) + 1;
    const tamperedRuns = rs.filter(r => r.tampered === 1).length;
    const judged = rs.filter(r => r.sourceCheat !== null);
    const sourceCheats = judged.filter(r => r.sourceCheat === 1).length;

    return {
      variant, provider: rs[0]!.provider, model: rs[0]!.model, effort: rs[0]!.effort,
      runCount: rs.length,
      scoredRuns: scored.length,
      scoredFixtures: fixturePassRates.length,
      passingRuns: scored.filter(r => r.passed === 1).length,
      passRate,
      ci: passRate === null ? null : wilsonCI(passRate, fixturePassRates.length),
      tamperedRuns,
      tamperRate: rs.length ? tamperedRuns / rs.length : 0,
      refusals: rs.filter(r => r.stopReason === "refusal").length,
      errors: rs.filter(r => r.stopReason === "error").length,
      meanCost: mean(rs.map(r => r.costUsd)),
      meanSteps: mean(rs.map(r => r.steps ?? 0)),
      stepValues: rs.map(r => r.steps ?? 0),
      meanReasoning: mean(rs.map(r => r.reasoningTokens)),
      stopCounts,
      judgedRuns: judged.length,
      sourceCheats,
      sourceCheatRate: judged.length ? sourceCheats / judged.length : null,
    };
  }).sort((a, b) => a.variant.localeCompare(b.variant));
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const PASS_FILL = "#2563eb", TAMPER_FILL = "#b91c1c";

const pct = (value: number) => `${(value * 100).toFixed(0)}%`;

/** Pass and tamper share one percentage axis, but their denominators stay visible:
 * pass inference uses fixtures while tamper rate covers every recorded run. */
function passAndTamperChart(rows: VariantSummary[]): string {
  const W = 700, H = 54 * rows.length + 34, L = 150, span = W - L - 180;
  const bars = rows.map((r, i) => {
    const y = 18 + i * 54;
    const pass = r.passRate === null || r.ci === null
      ? `<text x="${L + 8}" y="${y + 12}" class="val">N/A - no scored runs</text>`
      : (() => {
          const w = span * r.passRate;
          const lo = span * r.ci.lo, hi = span * r.ci.hi;
          return `<rect x="${L}" y="${y}" width="${w}" height="14" class="bar"/>
      <line x1="${L + lo}" x2="${L + hi}" y1="${y + 7}" y2="${y + 7}" class="ci"/>
      <line x1="${L + lo}" x2="${L + lo}" y1="${y + 1}" y2="${y + 13}" class="ci"/>
      <line x1="${L + hi}" x2="${L + hi}" y1="${y + 1}" y2="${y + 13}" class="ci"/>
      <text x="${L + span + 10}" y="${y + 12}" class="val">${pct(r.passRate)} - ${r.scoredFixtures} fixtures</text>`;
        })();
    return `
      <text x="${L - 8}" y="${y + 12}" text-anchor="end" class="lbl">${esc(r.variant)}</text>
      ${pass}
      <rect x="${L}" y="${y + 20}" width="${span * r.tamperRate}" height="10" class="tamper"/>
      <text x="${L + span + 10}" y="${y + 29}" class="val">${r.tamperedRuns}/${r.runCount} tampered</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" aria-hidden="true" focusable="false">
    <line x1="${L}" x2="${L}" y1="14" y2="${H - 14}" class="axis"/>${bars}</svg>`;
}

/** One point per variant. Used twice — cost/pass and reasoning/pass — because those
 *  two charts differ only in what is on x, and a second copy would drift. */
function scatter(
  rows: VariantSummary[], xOf: (r: VariantSummary) => number, xTitle: string,
  fmtX: (v: number) => string, yTitle: string,
): string {
  const W = 700, H = 300, L = 60, B = 40;
  const xMax = Math.max(...rows.map(xOf), Number.EPSILON) * 1.12;
  const px = (v: number) => L + (W - L - 20) * (v / xMax);
  const py = (v: number) => H - B - (H - B - 30) * v;
  const pts = rows.map((r, i) => r.passRate === null ? "" : `
    <circle cx="${px(xOf(r))}" cy="${py(r.passRate)}" r="10" class="bar"/>
    <text x="${px(xOf(r))}" y="${py(r.passRate) + 4}" text-anchor="middle" class="point-key">${i + 1}</text>`).join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(v => `
    <line x1="${L}" x2="${W - 20}" y1="${py(v)}" y2="${py(v)}" class="grid"/>
    <text x="${L - 8}" y="${py(v) + 4}" text-anchor="end" class="val">${(v * 100).toFixed(0)}%</text>`).join("");
  const xticks = [0, xMax / 2, xMax].map(v => `
    <text x="${px(v)}" y="${H - B + 18}" text-anchor="middle" class="val">${fmtX(v)}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" aria-hidden="true" focusable="false">
    ${ticks}${xticks}${pts}
    <text x="${(W + L) / 2}" y="${H - 4}" text-anchor="middle" class="val">${esc(xTitle)}</text>
    <text x="14" y="${H / 2}" transform="rotate(-90 14 ${H / 2})" text-anchor="middle" class="val">${esc(yTitle.toLowerCase())}</text>
  </svg>`;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** One dot per run. Repeated values tile into compact stacks instead of occupying
 * the same pixel, so frequency remains visible. */
function stepDistribution(rows: VariantSummary[]): string {
  const W = 700, L = 150, columns = 5;
  const max = Math.max(1, ...rows.flatMap(r => r.stepValues));
  const counts = rows.map(r => {
    const byStep = new Map<number, number>();
    for (const step of r.stepValues) byStep.set(step, (byStep.get(step) ?? 0) + 1);
    return byStep;
  });
  const largestCount = Math.max(1, ...counts.flatMap(c => [...c.values()]));
  const rowHeight = Math.max(64, Math.ceil(largestCount / columns) * 8 + 34);
  const H = rowHeight * rows.length + 38;
  const px = (v: number) => L + (W - L - 60) * (v / max);
  const body = rows.map((r, i) => {
    const baseline = 12 + (i + 1) * rowHeight - 30;
    const med = median(r.stepValues);
    const dots = [...counts[i]!.entries()].sort(([a], [b]) => a - b).map(([step, count]) => {
      const units = Array.from({ length: count }, (_, j) => {
        const col = j % columns, stack = Math.floor(j / columns);
        const rowCount = Math.min(columns, count - stack * columns);
        return `<circle cx="${px(step) + (col - (rowCount - 1) / 2) * 7}" cy="${baseline - stack * 7}" r="3" class="dot"/>`;
      }).join("");
      const top = baseline - (Math.ceil(count / columns) - 1) * 7 - 8;
      return `${units}<text x="${px(step)}" y="${top}" text-anchor="middle" class="val">${count}</text>`;
    }).join("");
    const min = Math.min(...r.stepValues, 0), maxStep = Math.max(...r.stepValues, 0);
    return `
      <text x="${L - 8}" y="${baseline + 4}" text-anchor="end" class="lbl">${esc(r.variant)}</text>
      <line x1="${px(min)}" x2="${px(maxStep)}" y1="${baseline}" y2="${baseline}" class="axis"/>
      ${dots}
      <line x1="${px(med)}" x2="${px(med)}" y1="${baseline + 5}" y2="${baseline + 16}" class="median"/>
      <text x="${W - 55}" y="${baseline + 15}" class="val">med ${med.toFixed(1)}</text>`;
  }).join("");
  const xticks = [0, max / 2, max].map(v => `
    <text x="${px(v)}" y="${H - 6}" text-anchor="middle" class="val">${v.toFixed(0)}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" aria-hidden="true" focusable="false">
    ${body}${xticks}</svg>`;
}

/** Fixed stop-reason colours remain comparable across reports. `end_turn` is blue,
 * not success-green: ending normally says nothing about whether scoring passed. */
const STOP_FILL: Record<string, string> = {
  end_turn: "#2563eb", max_steps: "#f59e0b", max_tokens: "#a855f7",
  refusal: "#6b7280", error: "#b91c1c", unknown: "#cbd5e1",
};

function stopKinds(rows: VariantSummary[]): string[] {
  const present = [...new Set(rows.flatMap(r => Object.keys(r.stopCounts)))];
  return [...Object.keys(STOP_FILL).filter(k => present.includes(k)),
          ...present.filter(k => !(k in STOP_FILL))];
}

function stopStack(rows: VariantSummary[]): string {
  const W = 700, H = 34 * rows.length + 34, L = 150, span = W - L - 60;
  const kinds = stopKinds(rows);
  const body = rows.map((r, i) => {
    const y = 20 + i * 34;
    const total = Object.values(r.stopCounts).reduce((a, b) => a + b, 0) || 1;
    let x = L;
    const segs = kinds.map(k => {
      const n = r.stopCounts[k] ?? 0;
      if (!n) return "";
      const w = span * (n / total);
      const seg = `<rect x="${x}" y="${y}" width="${w}" height="18" fill="${STOP_FILL[k] ?? "#94a3b8"}"/>`;
      x += w;
      return seg;
    }).join("");
    return `<text x="${L - 8}" y="${y + 14}" text-anchor="end" class="lbl">${esc(r.variant)}</text>
      ${segs}<text x="${L + span + 8}" y="${y + 14}" class="val">n=${total}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" aria-hidden="true" focusable="false">${body}</svg>`;
}

function chartDataTable(caption: string, headers: string[], body: string[][]): string {
  const head = headers.map(h => `<th scope="col">${esc(h)}</th>`).join("");
  const rows = body.map(cells => `<tr>${cells.map((cell, i) => i === 0
    ? `<th scope="row">${esc(cell)}</th>` : `<td>${esc(cell)}</td>`).join("")}</tr>`).join("");
  return `<details class="data-view"><summary>View chart data</summary>
    <div class="table-scroll" tabindex="0"><table><caption>${esc(caption)}</caption>
    <thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

function scatterData(rows: VariantSummary[], metric: string, xOf: (r: VariantSummary) => number,
                     fmtX: (v: number) => string, rateLabel: string): string {
  return chartDataTable(`${metric} and ${rateLabel.toLowerCase()} by variant`, ["Key", "Variant", metric, rateLabel, "Evidence"],
    rows.map((r, i) => [String(i + 1), r.variant, fmtX(xOf(r)),
      r.passRate === null ? "N/A" : pct(r.passRate),
      r.passRate === null ? "0 scored runs" : `${r.scoredRuns} run${r.scoredRuns === 1 ? "" : "s"} across ${r.scoredFixtures} fixture${r.scoredFixtures === 1 ? "" : "s"}`]));
}

function stepData(rows: VariantSummary[]): string {
  const body: string[][] = [];
  for (const r of rows) {
    const counts = new Map<number, number>();
    for (const step of r.stepValues) counts.set(step, (counts.get(step) ?? 0) + 1);
    for (const [step, count] of [...counts].sort(([a], [b]) => a - b)) {
      body.push([r.variant, String(step), String(count), median(r.stepValues).toFixed(1)]);
    }
  }
  return chartDataTable("Run counts at each step count", ["Variant", "Steps", "Runs", "Variant median"], body);
}

function stopData(rows: VariantSummary[]): string {
  const body = rows.flatMap(r => stopKinds(rows).filter(k => r.stopCounts[k])
    .map(k => [r.variant, k, String(r.stopCounts[k]) ]));
  return chartDataTable("Stop reasons by variant", ["Variant", "Stop reason", "Runs"], body);
}

function stopLegend(rows: VariantSummary[]): string {
  return `<div class="stop-legend" aria-hidden="true">${stopKinds(rows).map(k =>
    `<span><i style="--stop-color:${STOP_FILL[k] ?? "#94a3b8"}"></i>${esc(k)}</span>`).join("")}</div>`;
}

/** Payloads carry whole model responses, so they are truncated: the drill-down is
 *  for reading what a run DID, and the sweep database is the full record. */
const PAYLOAD_CHARS = 400;

export function matchesRunFilter(
  searchText: string, outcome: string, flags: string, query: string, selected: string,
): boolean {
  const matchesText = searchText.includes(query.trim().toLowerCase());
  const matchesView = selected === "all" || outcome === selected || flags.split(" ").includes(selected);
  return matchesText && matchesView;
}

interface SweepScope {
  tier: string; source: string; fixtures: number; repetitions: string; dataThrough: string; control: boolean;
}

function describeSweep(dbPath: string, runs: RunRow[]): SweepScope {
  const tasks = [...new Set(runs.map(r => r.taskId))];
  const taskNumbers = tasks.map(task => Number.parseInt(task.split("-")[0] ?? "", 10));
  const control = taskNumbers.length > 0 && taskNumbers.every(n => n >= 900);
  const tier = control ? "Control-tier sweep"
    : taskNumbers.length > 0 && taskNumbers.every(n => n >= 100 && n < 900) ? "Hard-tier sweep"
    : taskNumbers.length > 0 && taskNumbers.every(n => n >= 0 && n < 100) ? "Easy-tier sweep"
    : "Custom sweep";
  const repsByCell = new Map<string, Set<number>>();
  for (const run of runs) {
    const key = `${run.variant}\u0000${run.taskId}`;
    const reps = repsByCell.get(key) ?? new Set<number>();
    reps.add(run.rep);
    repsByCell.set(key, reps);
  }
  const repCounts = [...repsByCell.values()].map(reps => reps.size);
  const minReps = repCounts.length ? Math.min(...repCounts) : 0;
  const maxReps = repCounts.length ? Math.max(...repCounts) : 0;
  const repetitions = minReps === maxReps ? String(minReps) : `${minReps}-${maxReps}`;
  const timestamps = runs.flatMap(r => [r.endedAt, r.startedAt]).filter((v): v is string => Boolean(v));
  const latest = timestamps.sort().at(-1);
  return {
    tier,
    source: path.basename(dbPath),
    fixtures: tasks.length,
    repetitions,
    dataThrough: latest ? latest.slice(0, 10) : "unknown",
    control,
  };
}

/** True when a run's stream holds the same seq twice: two executions of the cell were
 *  written under one run id. Three published runs are like this, and the drill-down is
 *  exactly where a reader would otherwise take an interleaved stream for one
 *  execution. Computed from the events in hand rather than queried, because the
 *  report already has them. */
function isCommingled(events: StoredEvent[]): boolean {
  return new Set(events.map(e => e.seq)).size !== events.length;
}

function trajectories(runs: RunRow[], eventsFor: (id: string) => StoredEvent[], successLabel: string): string {
  return [...runs].sort((a, b) => a.id.localeCompare(b.id)).map(r => {
    const events = eventsFor(r.id);
    const rows = events.map(e => {
      const tok = [["in", e.inTok], ["cache-r", e.crTok], ["out", e.outTok], ["rsn", e.rsnTok]]
        .filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(", ");
      const payload = e.payload ?? "";
      return `<tr><td>${e.seq}</td><td>${esc(e.type)}</td><td>${esc(e.name ?? "")}</td>
        <td class="num">${esc(tok)}</td><td class="num">${e.latencyMs ?? ""}</td>
        <td><code>${esc(payload.slice(0, PAYLOAD_CHARS))}${payload.length > PAYLOAD_CHARS ? " ..." : ""}</code></td></tr>`;
    }).join("");
    const cheat = r.sourceCheat === null ? ""
      : `  judge=${r.sourceCheat ? `CHEATED (${esc(r.sourceCheatKind ?? "?")})` : "clean"}`;
    const commingled = isCommingled(events);
    const outcome = r.stopReason === "error" || r.stopReason === "refusal"
      ? r.stopReason
      : r.passed === 1 ? "passed" : "failed";
    const flags = [r.tampered ? "tampered" : "", r.sourceCheat ? "cheated" : ""]
      .filter(Boolean).join(" ");
    const search = [r.id, r.variant, r.provider, r.model, r.stopReason ?? "", r.sourceCheatKind ?? ""]
      .join(" ").toLowerCase();
    const outcomeLabel = outcome === "passed" ? successLabel : outcome === "failed" ? "Failed"
      : outcome === "error" ? "Error" : "Refusal";
    return `<details class="run" data-search="${esc(search)}" data-outcome="${outcome}" data-flags="${flags}"><summary>
      <span class="run-summary-main"><span class="run-id">${esc(r.id)}</span><span class="status status-${outcome}">${outcomeLabel}</span>${r.tampered ? `<span class="status status-warning">Tampered</span>` : ""}${r.sourceCheat ? `<span class="status status-warning">Cheat: ${esc(r.sourceCheatKind ?? "unknown")}</span>` : ""}${commingled ? `<span class="status status-warning">&#9888; COMMINGLED</span>` : ""}</span>
      <span class="run-summary-meta"><span>${r.steps ?? 0} steps</span><span>$${r.costUsd.toFixed(4)}</span></span>
      <span class="sr-only">${esc(r.stopReason ?? "?")} passed=${r.passed ?? "NULL"} tampered=${r.tampered ?? 0}${cheat}</span>
      </summary>
      ${commingled ? `<p class="note"><strong>Two executions are stored under this run id.</strong>
        Some seq positions hold events from both, so this is not one unambiguous trajectory.
        Rows are in write order, and a seq that goes <em>backwards</em> marks where the second
        execution's events begin. The run row above came from whichever execution finished
        last, so it may not describe the events you are reading.</p>` : ""}
      ${r.error ? `<p class="note">${esc(r.error)}</p>` : ""}
      ${r.sourceCheatEvidence ? `<p class="note">judge: ${esc(r.sourceCheatEvidence)}</p>` : ""}
      <div class="table-scroll" role="region" aria-label="Trajectory for ${esc(r.id)}" tabindex="0">
      <table class="traj"><caption class="sr-only">Stored trajectory events for ${esc(r.id)}</caption>
      <thead><tr><th scope="col">seq</th><th scope="col">type</th><th scope="col">name</th><th scope="col">tokens</th><th scope="col">ms</th><th scope="col">payload</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6">no events recorded</td></tr>`}</tbody></table></div></details>`;
  }).join("\n");
}

export function buildReport(dbPath: string, outPath: string): void {
  // Read-only: the published sweep databases are tracked evidence, and a plain open
  // would set a journal mode and create any table SCHEMA has gained since — writing
  // to the file this report exists to summarise. It also turns a typo'd path into a
  // failure instead of a confident report of 0 runs.
  if (!fs.existsSync(dbPath)) throw new Error(`no such database: ${dbPath}`);
  const store = openStore(dbPath, { readonly: true });
  const runs = store.allRuns();
  const rows = summarise(runs);
  const scope = describeSweep(dbPath, runs);
  const rateLabel = scope.control ? "Escape rate" : "Pass rate";
  const successLabel = scope.control ? "Escaped" : "Passed";
  const providers = [...new Set(runs.map(r => r.provider))];
  // Read the trajectories before closing. The drill-down is part of the report, not
  // an extra: a reader who cannot see what a run did has to take the aggregate on
  // trust, which is the opposite of what this harness is for.
  const eventsByRun = new Map(runs.map(r => [r.id, store.eventsForRun(r.id)]));
  store.close();

  const judgeVerdicts = rows.reduce((sum, r) => sum + r.judgedRuns, 0);
  const judgeRan = judgeVerdicts > 0;
  const scoredRuns = runs.filter(r => r.passed !== null);
  const passedRuns = scoredRuns.filter(r => r.passed === 1).length;
  const scoredFixtureCells = rows.reduce((sum, r) => sum + r.scoredFixtures, 0);
  const overallPassRate = scoredFixtureCells
    ? rows.reduce((sum, r) => sum + (r.passRate ?? 0) * r.scoredFixtures, 0) / scoredFixtureCells
    : null;
  const totalCost = runs.reduce((sum, r) => sum + r.costUsd, 0);
  const totalReasoning = runs.reduce((sum, r) => sum + r.reasoningTokens, 0);
  const tamperedRuns = runs.filter(r => r.tampered === 1).length;
  const sourceCheats = runs.filter(r => r.sourceCheat === 1).length;
  const passingWithoutVerdict = Math.max(0, passedRuns - judgeVerdicts);
  const table = rows.map(r => `<tr>
    <th scope="row">${esc(r.variant)}</th><td>${esc(r.provider)}/${esc(r.model)}</td><td>${esc(r.effort)}</td>
    <td>${r.passRate === null ? "N/A" : pct(r.passRate)}</td>
    <td>${r.ci === null ? "N/A" : `[${pct(r.ci.lo)}, ${pct(r.ci.hi)}]`}</td>
    <td>${r.scoredRuns} run${r.scoredRuns === 1 ? "" : "s"} / ${r.scoredFixtures} fixture${r.scoredFixtures === 1 ? "" : "s"}</td>
    <td>${r.tamperedRuns}/${r.runCount} (${pct(r.tamperRate)})</td>
    <td>${r.meanSteps.toFixed(1)}</td>
    <td>${Math.round(r.meanReasoning)}</td>
    <td>$${r.meanCost.toFixed(4)}</td>
    <td>${r.refusals}/${r.errors}</td>
    ${judgeRan ? `<td>${r.sourceCheatRate === null ? "No verdicts" : `${r.sourceCheats}/${r.judgedRuns} (${pct(r.sourceCheatRate)})`}</td>` : ""}
  </tr>`).join("");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(scope.tier)} | Agent Eval Harness</title>
<style>
 :root{color-scheme:light;--ink:#17191d;--muted:#616874;--line:#d9dde4;--soft:#f3f5f7;--paper:#fff;--pass:${PASS_FILL};--tamper:${TAMPER_FILL};--accent:#e9a923;--success:#16815c}
 *{box-sizing:border-box;letter-spacing:0}
 html{scroll-behavior:smooth;scroll-padding-top:4.5rem}
 body{margin:0;background:#f7f8fa;color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
 button,input,select{font:inherit;letter-spacing:0}
 a{color:inherit}
 .sr-only{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
 .skip-link{position:fixed;z-index:100;top:.5rem;left:.5rem;padding:.6rem .8rem;background:#fff;border:2px solid var(--pass);border-radius:4px;color:var(--ink);font-weight:700;transform:translateY(-160%)}
 .skip-link:focus{transform:translateY(0)}
 .masthead{background:#17191d;color:#fff;border-bottom:4px solid var(--accent)}
 .masthead-inner{max-width:1180px;min-width:0;margin-inline:auto;padding:3rem 1.5rem 2.75rem;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2rem;align-items:end}
 .eyebrow{margin:0 0 .55rem;color:#f0bf58;font-size:12px;font-weight:750;text-transform:uppercase}
 h1{max-width:760px;margin:0;font-size:42px;line-height:1.05;font-weight:780;text-wrap:balance}
 .lede{max-width:670px;margin:.85rem 0 0;color:#cdd1d8;font-size:17px;text-wrap:pretty}
 .masthead-meta{display:grid;gap:.65rem;min-width:240px;margin:0;padding-inline-start:1.25rem;border-inline-start:1px solid #41454e;color:#cdd1d8}
 .masthead-meta div{display:grid;grid-template-columns:92px minmax(0,1fr);gap:.75rem}.masthead-meta dt{font-size:11px;font-weight:750;text-transform:uppercase}.masthead-meta dd{min-width:0;margin:0;color:#fff;font-size:13px;overflow-wrap:anywhere}.masthead-meta code{font-size:12px}
 .section-nav{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.96);border-bottom:1px solid var(--line)}
 .section-nav-inner{max-width:1180px;margin-inline:auto;padding-inline:1.5rem;display:flex;gap:1.5rem;overflow-x:auto;scrollbar-width:thin}
 .section-nav a{flex:none;padding:.9rem 0 .75rem;border-bottom:3px solid transparent;color:var(--muted);font-size:13px;font-weight:700;text-decoration:none}
 .section-nav a:hover,.section-nav a:focus-visible{color:var(--ink);border-color:var(--accent);outline:none}
 .report-shell{width:100%;max-width:1180px;min-width:0;margin-inline:auto;padding:2rem 1.5rem 5rem}
 .metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1px;margin:0 0 1.5rem;background:var(--line);border:1px solid var(--line);border-radius:6px;overflow:clip}
 .metric{min-width:0;margin:0;padding:1.1rem 1.2rem;background:var(--paper);border-top:3px solid transparent}
 .metric:first-child{border-top-color:var(--accent)}
 .metric dt{color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase}
 .metric dd{margin:.25rem 0 0;font-size:27px;line-height:1.1;font-weight:760;font-variant-numeric:tabular-nums}
 .metric small{display:block;margin-top:.35rem;color:var(--muted);font-size:12px}
 .note{margin:1.25rem 0;padding:.8rem 1rem;background:#fff7df;border-inline-start:4px solid var(--accent);color:#4d3c15;text-wrap:pretty}
 .report-section{min-width:0;padding-block:3rem;border-top:1px solid var(--line)}
 .summary-section{padding-top:.5rem;border-top:0}
 .section-heading{display:grid;grid-template-columns:42px minmax(0,1fr);gap:1rem;align-items:start;margin-bottom:1.35rem}
 .section-index{display:grid;place-items:center;width:38px;height:38px;background:var(--ink);border-radius:4px;color:#fff;font:700 12px/1 ui-monospace,SFMono-Regular,Consolas,monospace}
 h2,h3{margin:0;text-wrap:balance}
 h2{font-size:26px;line-height:1.2}
 h3{font-size:17px;line-height:1.3}
 .section-heading p,.figure-head p{margin:.35rem 0 0;color:var(--muted);text-wrap:pretty}
 .chart-surface{min-width:0;background:var(--paper);border:1px solid var(--line);border-radius:6px;overflow:clip}
 .figure-head{padding:1.1rem 1.2rem .35rem}
 .chart-frame{width:100%;min-width:0;overflow-x:auto;padding:.4rem 1rem 1rem;scrollbar-gutter:stable;overscroll-behavior-inline:contain}
 .chart-frame svg{display:block;min-width:560px;max-height:440px}
 .chart-frame .bar{fill:var(--pass)}.chart-frame .tamper{fill:var(--tamper)}.chart-frame .dot{fill:var(--pass);opacity:.72}
 .chart-frame .ci{stroke:var(--ink);stroke-width:2}.chart-frame .median{stroke:var(--accent);stroke-width:3}.chart-frame .axis{stroke:#6b7280}.chart-frame .grid{stroke:#d9dee7;stroke-dasharray:3 4}
 .chart-frame .lbl{font:600 13px system-ui,-apple-system,"Segoe UI",sans-serif;fill:var(--ink)}
 .chart-frame .val{font:12px system-ui,-apple-system,"Segoe UI",sans-serif;fill:var(--muted)}
 .chart-frame .point-key{font:750 11px system-ui,-apple-system,"Segoe UI",sans-serif;fill:#fff}
 .chart-frame .bar,.chart-frame .tamper,.chart-frame .dot{transition:opacity .16s ease,filter .16s ease}
 .chart-frame .bar:hover,.chart-frame .tamper:hover,.chart-frame .dot:hover{filter:brightness(.82);opacity:1}
 .legend{display:flex;flex-wrap:wrap;gap:.75rem 1.25rem;margin:0;padding:.85rem 1.2rem 0;color:var(--muted);font-size:12px}
 .legend span{display:inline-flex;align-items:center;gap:.45rem}.swatch{width:20px;height:5px;background:var(--pass)}.swatch-tamper{background:var(--tamper)}
 .stop-legend{display:flex;flex-wrap:wrap;gap:.5rem 1rem;padding:.75rem 1.2rem 0;color:var(--muted);font-size:12px}.stop-legend span{display:inline-flex;align-items:center;gap:.4rem}.stop-legend i{width:10px;height:10px;background:var(--stop-color)}
 .chart-grid{min-width:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,500px),1fr));gap:1rem}
 .table-scroll{width:100%;overflow:auto;scrollbar-gutter:stable;overscroll-behavior-inline:contain}
 .compare-scroll{margin-top:1rem;background:var(--paper);border:1px solid var(--line);border-radius:6px}
 table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}caption{padding:.8rem;text-align:left;font-weight:700}
 th,td{padding:.72rem .8rem;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
 th{background:#eef1f4;color:#454b55;font-size:11px;font-weight:780;text-transform:uppercase;white-space:nowrap}
 tbody tr:last-child :is(th,td){border-bottom:0}tbody tr:hover :is(th,td){background:#f8fafc}
 .data-view{border-top:1px solid var(--line)}.data-view>summary{padding:.75rem 1.2rem;color:var(--muted);font-size:12px;font-weight:700;cursor:pointer}.data-view>summary:hover{background:#f5f7f9}.data-view table{min-width:540px}
 .method-note{max-width:860px;margin:1rem 0 0;color:var(--muted);font-size:12px;text-wrap:pretty}
 .run-tools{display:flex;flex-wrap:wrap;gap:.75rem;align-items:end;margin:0 0 1rem;padding:1rem;background:#eef1f4;border:1px solid var(--line);border-radius:6px}
 .field{display:grid;gap:.3rem;flex:1 1 260px;min-width:0}.field-filter{flex:0 1 190px}
 .control-label{color:#454b55;font-size:11px;font-weight:780;text-transform:uppercase}
 input,select,button{min-height:40px;border:1px solid #aeb5c0;border-radius:4px;background:#fff;color:var(--ink)}
 input,select{width:100%;padding:.5rem .7rem}:where(a,summary,input,select,button):focus-visible{outline:3px solid rgba(37,99,235,.3);outline-offset:2px;border-color:var(--pass)}
 button{padding:.5rem .8rem;font-weight:700;cursor:pointer}button:hover{background:#e4e8ed}
 .run-count{margin:0 0 0 auto;padding:.55rem 0;color:var(--muted);font-size:13px;white-space:nowrap}
 .run-list{border-top:1px solid var(--line)}
 details.run{background:var(--paper);border-bottom:1px solid var(--line);content-visibility:auto;contain-intrinsic-size:auto 58px}
 details.run[open]{border-inline-start:4px solid var(--accent)}
 details.run>summary{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.5rem 1rem;align-items:center;min-height:58px;padding:.8rem 1rem;cursor:pointer;list-style:none}
 details.run>summary::-webkit-details-marker{display:none}details.run>summary::before{content:"+";grid-column:2;grid-row:1;color:var(--muted);font:700 18px/1 ui-monospace,SFMono-Regular,Consolas,monospace}
 details.run[open]>summary::before{content:"-"}details.run>summary:hover,details.run>summary:focus-visible{background:#f5f7f9}
 .run-summary-main{display:flex;flex-wrap:wrap;gap:.45rem;align-items:center;min-width:0}.run-id{min-width:0;overflow-wrap:anywhere;font:650 13px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
 .run-summary-meta{grid-column:2;grid-row:2;display:flex;justify-content:flex-end;gap:.8rem;color:var(--muted);font:12px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace}
 .status{display:inline-flex;align-items:center;min-height:22px;padding:.15rem .45rem;border-radius:3px;font-size:11px;font-weight:750}
 .status-passed{background:#e3f4ec;color:#096444}.status-failed,.status-error{background:#fbe8e7;color:#9e2525}.status-refusal{background:#e8ebef;color:#4f5661}.status-warning{background:#fff0c9;color:#74520a}
 details.run>.note{margin:0 1rem 1rem}
 table.traj{min-width:850px;font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;table-layout:fixed}
 table.traj th:nth-child(1){width:54px}table.traj th:nth-child(2){width:110px}table.traj th:nth-child(3){width:130px}table.traj th:nth-child(4){width:130px}table.traj th:nth-child(5){width:75px}
 table.traj td{vertical-align:top;overflow-wrap:anywhere}table.traj .num{text-align:right;white-space:nowrap}table.traj code{color:#313640;white-space:pre-wrap}
 [hidden]{display:none!important}
 @media (max-width:720px){.masthead-inner{grid-template-columns:minmax(0,1fr);padding:2.25rem 1rem 2rem}h1{font-size:34px}.lede{font-size:15px}.masthead-meta{min-width:0;padding:1rem 0 0;border-inline-start:0;border-top:1px solid #41454e}.section-nav-inner,.report-shell{padding-inline:1rem}.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.report-section{padding-block:2.4rem}.section-heading{grid-template-columns:32px minmax(0,1fr);gap:.75rem}.section-index{width:30px;height:30px}h2{font-size:22px}.chart-frame svg{min-width:620px}.run-count{width:100%;margin:0}details.run>summary{grid-template-columns:minmax(0,1fr) 20px}}
 @media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}.chart-frame *{transition:none!important}}
 @media print{.section-nav,.run-tools{display:none}.masthead{background:#fff;color:#000;border-bottom:2px solid #000}.lede,.masthead-meta{color:#333}.report-shell{max-width:none}.report-section{break-inside:avoid}.chart-surface{border-color:#bbb}}
</style>
 </head>
<body>
<a class="skip-link" href="#content">Skip to report content</a>
<header class="masthead"><div class="masthead-inner">
 <div><p class="eyebrow">${esc(scope.tier)}</p><h1>Agent Eval Harness</h1>
  <p class="lede">Performance, cost, and integrity for ${scope.fixtures} fixture${scope.fixtures === 1 ? "" : "s"} with ${scope.repetitions} repetition${scope.repetitions === "1" ? "" : "s"} per recorded cell.</p></div>
 <dl class="masthead-meta"><div><dt>Source</dt><dd><code>${esc(scope.source)}</code></dd></div>
  <div><dt>Evidence through</dt><dd>${esc(scope.dataThrough)}</dd></div>
  <div><dt>Scope</dt><dd>${runs.length} run${runs.length === 1 ? "" : "s"} / ${rows.length} variant${rows.length === 1 ? "" : "s"}</dd></div></dl>
</div></header>
<nav class="section-nav" aria-label="Report sections"><div class="section-nav-inner">
 <a href="#overview">Overview</a><a href="#quality">Quality</a><a href="#efficiency">Efficiency</a>
 <a href="#behaviour">Behaviour</a><a href="#runs">Runs</a>
</div></nav>
<main id="content" class="report-shell" tabindex="-1">
<section id="overview" class="report-section summary-section" aria-labelledby="overview-title">
 <h2 id="overview-title" class="sr-only">Overview</h2>
 <dl class="metric-grid" aria-label="Report summary">
  <div class="metric"><dt>Recorded runs</dt><dd>${runs.length}</dd><small>${rows.length} variant${rows.length === 1 ? "" : "s"}</small></div>
  <div class="metric"><dt>Overall ${rateLabel.toLowerCase()}</dt><dd>${overallPassRate === null ? "N/A" : pct(overallPassRate)}</dd><small>${passedRuns}/${scoredRuns.length} scored runs; ${scoredFixtureCells} fixture cells</small></div>
  <div class="metric"><dt>Total API cost</dt><dd>$${totalCost.toFixed(3)}</dd><small>from recorded usage</small></div>
  <div class="metric"><dt>Reasoning tokens</dt><dd>${Math.round(totalReasoning).toLocaleString("en-US")}</dd><small>agent total</small></div>
  <div class="metric"><dt>Protected-file tampering</dt><dd>${tamperedRuns}/${runs.length}</dd><small>checked on every recorded run</small></div>
  <div class="metric"><dt>Source-cheat review</dt><dd>${judgeRan ? `${sourceCheats}/${judgeVerdicts}` : "Not recorded"}</dd><small>${judgeRan ? `${passingWithoutVerdict} passing run${passingWithoutVerdict === 1 ? "" : "s"} without a verdict` : "0 judge verdicts in this sweep"}</small></div>
 </dl>
 ${providers.length === 1
  ? `<p class="note">This is a single-vendor sweep (<strong>${esc(providers[0]!)}</strong>). Effort and tool findings have not been shown to generalise across vendors.</p>`
  : ""}
</section>
<section id="quality" class="report-section" aria-labelledby="quality-title">
 <header class="section-heading"><span class="section-index" aria-hidden="true">01</span><div>
  <h2 id="quality-title">${rateLabel} and tamper rate by variant</h2>
  <p>Wilson 95% intervals use distinct fixtures as the effective sample size, so repeated runs do not create artificial certainty.</p>
 </div></header>
 <figure class="chart-surface">
  <figcaption class="legend"><span><i class="swatch" aria-hidden="true"></i>Fixture-balanced ${rateLabel.toLowerCase()} with Wilson 95% interval</span>
   <span><i class="swatch swatch-tamper" aria-hidden="true"></i>Protected-file tamper rate across all runs</span></figcaption>
  <div class="chart-frame">${passAndTamperChart(rows)}</div>
 </figure>
 <div class="table-scroll compare-scroll" role="region" aria-label="Variant comparison" tabindex="0">
 <table><caption class="sr-only">Complete variant comparison and chart data</caption><thead><tr><th scope="col">Variant</th><th scope="col">Model</th><th scope="col">Effort</th><th scope="col">${scope.control ? "Escape" : "Pass"}</th><th scope="col">Wilson 95% CI</th><th scope="col">${scope.control ? "Escape" : "Pass"} evidence</th><th scope="col">Tamper</th>
  <th scope="col">Steps</th><th scope="col">Reasoning tok</th><th scope="col">Cost/run</th><th scope="col">Refus/Err</th>${judgeRan ? "<th scope=\"col\">Judged source cheats</th>" : ""}</tr></thead>
  <tbody>${table}</tbody></table></div>
 <p class="method-note">${rateLabel}s average each fixture's repetition mean, so every fixture has equal weight. Refusals and harness errors are excluded from ${rateLabel.toLowerCase()}s and shown separately. Tamper, mean cost, steps, and reasoning cover every recorded run. Cost comes from recorded usage fields.</p>
</section>

<section id="efficiency" class="report-section" aria-labelledby="efficiency-title">
 <header class="section-heading"><span class="section-index" aria-hidden="true">02</span><div>
  <h2 id="efficiency-title">Efficiency</h2><p>${rateLabel} against the two resources each run consumes: money and reasoning.</p>
 </div></header>
 <div class="chart-grid">
  <figure class="chart-surface"><figcaption class="figure-head"><h3>Cost against ${rateLabel.toLowerCase()}</h3><p>Mean recorded cost per run, with numbered variants.</p></figcaption>
   <div class="chart-frame">${scatter(rows, r => r.meanCost, "mean cost per run (USD)", v => "$" + v.toFixed(4), rateLabel)}</div>
   ${scatterData(rows, "Mean cost/run", r => r.meanCost, v => "$" + v.toFixed(6), rateLabel)}</figure>
  <figure class="chart-surface"><figcaption class="figure-head"><h3>Reasoning tokens against ${rateLabel.toLowerCase()}</h3><p>Mean agent reasoning per run, with numbered variants.</p></figcaption>
   <div class="chart-frame">${scatter(rows, r => r.meanReasoning, "mean reasoning tokens per run", v => v.toFixed(0), rateLabel)}</div>
   ${scatterData(rows, "Mean reasoning tokens/run", r => r.meanReasoning, v => v.toFixed(2), rateLabel)}</figure>
 </div>
 <p class="method-note">Scatter x-values average all recorded runs; ${rateLabel.toLowerCase()} y-values exclude unscored runs and weight distinct fixtures equally. Variants without a scored run remain in the data tables as N/A and are not plotted at zero.</p>
</section>

<section id="behaviour" class="report-section" aria-labelledby="behaviour-title">
 <header class="section-heading"><span class="section-index" aria-hidden="true">03</span><div>
  <h2 id="behaviour-title">Run behaviour</h2><p>How long agents worked and why their runs stopped.</p>
 </div></header>
 <div class="chart-grid">
  <figure class="chart-surface"><figcaption class="figure-head"><h3>Step count distribution</h3><p>Each dot is one run; repeated values stack, and counts are printed above them.</p></figcaption>
   <div class="chart-frame">${stepDistribution(rows)}</div>${stepData(rows)}</figure>
  <figure class="chart-surface"><figcaption class="figure-head"><h3>Stop reason mix</h3><p>How runs ended, independent of whether their scored result passed.</p></figcaption>
   ${stopLegend(rows)}<div class="chart-frame">${stopStack(rows)}</div>${stopData(rows)}</figure>
 </div>
${judgeRan
  ? `<p class="note">Source-cheat rate uses ${judgeVerdicts} successfully judged passing patch${judgeVerdicts === 1 ? "" : "es"}; ${passingWithoutVerdict} passing run${passingWithoutVerdict === 1 ? "" : "s"} had no recorded verdict and ${passingWithoutVerdict === 1 ? "is" : "are"} excluded. The opt-in judge looks for hardcodes, special-cases, or mocks rather than a general fix. It uses <strong>${esc(JUDGE_MODEL)}</strong>, distinct from the models under test. Judge cost is included in Cost/run; token columns count the agent only.</p>`
  : ""}
</section>
<section id="runs" class="report-section" aria-labelledby="runs-title">
 <header class="section-heading"><span class="section-index" aria-hidden="true">04</span><div>
  <h2 id="runs-title">Trajectory drill-down</h2><p>Every recorded LLM call, tool call, result, and per-turn token count. Payload previews stop at ${PAYLOAD_CHARS} characters; the database retains the full record.</p>
 </div></header>
 <search class="run-tools" aria-label="Filter recorded trajectories">
  <div class="field"><label class="control-label" for="run-search">Search runs</label><input id="run-search" type="search" placeholder="Run ID, variant, model..." autocomplete="off"></div>
  <div class="field field-filter"><label class="control-label" for="run-filter">Outcome</label><select id="run-filter">
   <option value="all">All outcomes</option><option value="passed">${successLabel}</option><option value="failed">Failed</option>
   <option value="error">Errors</option><option value="refusal">Refusals</option><option value="tampered">Tampered</option><option value="cheated">Judged cheats</option>
  </select></div>
  <button type="button" id="expand-runs">Expand visible</button><button type="button" id="collapse-runs">Collapse all</button>
  <p id="run-count" class="run-count" aria-live="polite">${runs.length} of ${runs.length} runs</p>
 </search>
 <div id="run-list" class="run-list">${trajectories(runs, id => eventsByRun.get(id) ?? [], successLabel)}</div>
</section>
</main>
<script>
 (() => {
  const matchesRunFilter = (searchText, outcome, flags, query, selected) => {
   const matchesText = searchText.includes(query.trim().toLowerCase());
   const matchesView = selected === "all" || outcome === selected
     || flags.split(" ").includes(selected);
   return matchesText && matchesView;
  };
  const search = document.querySelector("#run-search");
  const filter = document.querySelector("#run-filter");
  const count = document.querySelector("#run-count");
  const items = [...document.querySelectorAll("details.run")];
  const applyFilters = () => {
   const query = search.value.trim().toLowerCase();
   const selected = filter.value;
   let visible = 0;
   for (const item of items) {
    item.hidden = !matchesRunFilter(item.dataset.search || "", item.dataset.outcome || "",
      item.dataset.flags || "", query, selected);
    if (!item.hidden) visible++;
   }
   count.textContent = visible + " of " + items.length + " runs";
  };
  search.addEventListener("input", applyFilters);
  filter.addEventListener("change", applyFilters);
  document.querySelector("#expand-runs").addEventListener("click", () => {
   for (const item of items) if (!item.hidden) item.open = true;
  });
  document.querySelector("#collapse-runs").addEventListener("click", () => {
   for (const item of items) item.open = false;
  });
 })();
</script>
</body>
</html>`;

  // Interpolations that render to nothing leave a line of pure indentation, so the
  // generated file failed `git diff --check` on 65 lines. Stripped at write time
  // rather than by hand-tuning every template: a generated artifact that cannot be
  // committed cleanly is a generated artifact people stop committing.
  // Trailing whitespace AND runs of blank lines. An interpolation that renders to
  // nothing leaves a line of pure indentation behind, and three optional blocks in a
  // row leave three blank lines in every run's drill-down. Both are cosmetic, both
  // are in a tracked artifact, and both are cheaper to fix once here than to keep out
  // of each template by hand.
  const clean = html.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(outPath, clean, "utf8");
  console.log(`wrote ${outPath} (${rows.length} variants, ${runs.length} runs)`);
}

// pathToFileURL, not `file://${argv[1]}`: on Windows argv[1] is a backslash path
// with no drive-prefix slash and no percent-encoding, so the naive comparison is
// never true and `npm run report` becomes a silent no-op.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildReport(process.argv[2] ?? "./eval.db", process.argv[3] ?? "./report.html");
}
