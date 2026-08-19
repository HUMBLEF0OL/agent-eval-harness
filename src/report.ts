import * as fs from "node:fs";
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

export interface VariantSummary {
  variant: string; provider: string; model: string; effort: string;
  scored: number; passRate: number; ci: { lo: number; hi: number };
  tamperRate: number; refusals: number; errors: number;
  meanCost: number; meanSteps: number; meanReasoning: number;
  /** Raw per-run step counts. The distribution chart needs the spread, and a mean
   *  cannot be un-averaged back into one. */
  stepValues: number[];
  stopCounts: Record<string, number>;
  /** null when the judge (stretch, opt-in --judge) never ran for this variant. */
  sourceCheatRate: number | null;
}

export function summarise(runs: RunRow[]): VariantSummary[] {
  const byVariant = new Map<string, RunRow[]>();
  for (const r of runs) (byVariant.get(r.variant) ?? byVariant.set(r.variant, []).get(r.variant)!).push(r);

  return [...byVariant].map(([variant, rs]) => {
    const scored = rs.filter(r => r.passed !== null);
    const passes = scored.map(r => r.passed!);
    const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const stopCounts: Record<string, number> = {};
    for (const r of rs) stopCounts[r.stopReason ?? "unknown"] = (stopCounts[r.stopReason ?? "unknown"] ?? 0) + 1;

    return {
      variant, provider: rs[0]!.provider, model: rs[0]!.model, effort: rs[0]!.effort,
      scored: scored.length,
      passRate: mean(passes),
      ci: bootstrapCI(passes),
      tamperRate: mean(scored.map(r => r.tampered ?? 0)),
      refusals: rs.filter(r => r.stopReason === "refusal").length,
      errors: rs.filter(r => r.stopReason === "error").length,
      meanCost: mean(rs.map(r => r.costUsd)),
      meanSteps: mean(rs.map(r => r.steps ?? 0)),
      stepValues: rs.map(r => r.steps ?? 0),
      meanReasoning: mean(rs.map(r => r.reasoningTokens)),
      stopCounts,
      sourceCheatRate: (() => {
        const judged = rs.filter(r => r.sourceCheat !== null);
        return judged.length ? mean(judged.map(r => r.sourceCheat!)) : null;
      })(),
    };
  }).sort((a, b) => a.variant.localeCompare(b.variant));
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const PASS_FILL = "#2563eb", TAMPER_FILL = "#b91c1c";

/** Pass rate and tamper rate on ONE axis, per TSD 14: they are both rates over the
 *  same runs, and separate axes invite reading a tamper bar drawn from 8 runs as if
 *  it were as well-evidenced as the pass rate beside it. */
function passAndTamperChart(rows: VariantSummary[]): string {
  const W = 700, H = 46 * rows.length + 46, L = 150, span = W - L - 90;
  const bars = rows.map((r, i) => {
    const y = 22 + i * 46, w = span * r.passRate;
    const lo = span * r.ci.lo, hi = span * r.ci.hi;
    return `
      <text x="${L - 8}" y="${y + 12}" text-anchor="end" class="lbl">${esc(r.variant)}</text>
      <rect x="${L}" y="${y}" width="${w}" height="14" class="bar"><title>${esc(r.variant)}: ${(r.passRate * 100).toFixed(0)}% pass rate, 95% CI ${(r.ci.lo * 100).toFixed(0)}-${(r.ci.hi * 100).toFixed(0)}%</title></rect>
      <line x1="${L + lo}" x2="${L + hi}" y1="${y + 7}" y2="${y + 7}" class="ci"/>
      <line x1="${L + lo}" x2="${L + lo}" y1="${y + 1}" y2="${y + 13}" class="ci"/>
      <line x1="${L + hi}" x2="${L + hi}" y1="${y + 1}" y2="${y + 13}" class="ci"/>
      <text x="${L + Math.max(w, hi) + 8}" y="${y + 12}" class="val">${(r.passRate * 100).toFixed(0)}% (n=${r.scored})</text>
      <rect x="${L}" y="${y + 17}" width="${span * r.tamperRate}" height="10" class="tamper"><title>${esc(r.variant)}: ${(r.tamperRate * 100).toFixed(0)}% tamper rate</title></rect>
      <text x="${L + span * r.tamperRate + 8}" y="${y + 26}" class="val">${(r.tamperRate * 100).toFixed(0)}% tampered</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Pass rate and tamper rate by variant">
    <line x1="${L}" x2="${L}" y1="14" y2="${H - 14}" class="axis"/>${bars}</svg>`;
}

/** One point per variant. Used twice — cost/pass and reasoning/pass — because those
 *  two charts differ only in what is on x, and a second copy would drift. */
function scatter(
  rows: VariantSummary[], xOf: (r: VariantSummary) => number, xTitle: string,
  fmtX: (v: number) => string, label: string,
): string {
  const W = 700, H = 300, L = 60, B = 40;
  const xMax = Math.max(...rows.map(xOf), Number.EPSILON) * 1.15;
  const px = (v: number) => L + (W - L - 20) * (v / xMax);
  const py = (v: number) => H - B - (H - B - 30) * v;
  const pts = rows.map(r => `
    <circle cx="${px(xOf(r))}" cy="${py(r.passRate)}" r="5" class="bar"><title>${esc(r.variant)}: ${(r.passRate * 100).toFixed(0)}% pass, ${esc(fmtX(xOf(r)))}</title></circle>
    <text x="${px(xOf(r)) + 9}" y="${py(r.passRate) + 4}" class="val">${esc(r.variant)}</text>`).join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(v => `
    <line x1="${L}" x2="${W - 20}" y1="${py(v)}" y2="${py(v)}" class="grid"/>
    <text x="${L - 8}" y="${py(v) + 4}" text-anchor="end" class="val">${(v * 100).toFixed(0)}%</text>`).join("");
  const xticks = [0, xMax / 2, xMax].map(v => `
    <text x="${px(v)}" y="${H - B + 18}" text-anchor="middle" class="val">${fmtX(v)}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(label)}">
    ${ticks}${xticks}${pts}
    <text x="${(W + L) / 2}" y="${H - 4}" text-anchor="middle" class="val">${esc(xTitle)}</text>
    <text x="14" y="${H / 2}" transform="rotate(-90 14 ${H / 2})" text-anchor="middle" class="val">pass rate</text>
  </svg>`;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** One dot per run with the median marked, one row per variant. A mean step count
 *  hides the shape that matters: whether a variant is steady or bimodal. */
function stepDistribution(rows: VariantSummary[]): string {
  const W = 700, H = 30 * rows.length + 40, L = 150;
  const max = Math.max(1, ...rows.flatMap(r => r.stepValues));
  const px = (v: number) => L + (W - L - 60) * (v / max);
  const body = rows.map((r, i) => {
    const y = 20 + i * 30;
    const med = median(r.stepValues);
    const dots = r.stepValues.map(v => `<circle cx="${px(v)}" cy="${y + 7}" r="3" class="dot"><title>${esc(r.variant)}: ${v} steps</title></circle>`).join("");
    return `
      <text x="${L - 8}" y="${y + 11}" text-anchor="end" class="lbl">${esc(r.variant)}</text>
      <line x1="${px(Math.min(...r.stepValues, max))}" x2="${px(Math.max(...r.stepValues, 0))}"
            y1="${y + 7}" y2="${y + 7}" class="grid"/>
      ${dots}
      <line x1="${px(med)}" x2="${px(med)}" y1="${y}" y2="${y + 14}" class="ci"/>
      <text x="${W - 55}" y="${y + 11}" class="val">med ${med.toFixed(1)}</text>`;
  }).join("");
  const xticks = [0, max / 2, max].map(v => `
    <text x="${px(v)}" y="${H - 6}" text-anchor="middle" class="val">${v.toFixed(0)}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Step count distribution by variant">
    ${body}${xticks}</svg>`;
}

/** Deliberately fixed, not generated: `error` must always read red and `end_turn`
 *  green, or two reports of the same sweep become visually incomparable. */
const STOP_FILL: Record<string, string> = {
  end_turn: "#16a34a", max_steps: "#f59e0b", max_tokens: "#a855f7",
  refusal: "#6b7280", error: "#b91c1c", unknown: "#cbd5e1",
};

function stopStack(rows: VariantSummary[]): string {
  const W = 700, H = 34 * rows.length + 56, L = 150, span = W - L - 60;
  const present = [...new Set(rows.flatMap(r => Object.keys(r.stopCounts)))];
  const kinds = [...Object.keys(STOP_FILL).filter(k => present.includes(k)),
                 ...present.filter(k => !(k in STOP_FILL))];
  const body = rows.map((r, i) => {
    const y = 20 + i * 34;
    const total = Object.values(r.stopCounts).reduce((a, b) => a + b, 0) || 1;
    let x = L;
    const segs = kinds.map(k => {
      const n = r.stopCounts[k] ?? 0;
      if (!n) return "";
      const w = span * (n / total);
      const seg = `<rect x="${x}" y="${y}" width="${w}" height="18" fill="${STOP_FILL[k] ?? "#94a3b8"}"><title>${esc(k)}: ${n}</title></rect>`;
      x += w;
      return seg;
    }).join("");
    return `<text x="${L - 8}" y="${y + 14}" text-anchor="end" class="lbl">${esc(r.variant)}</text>
      ${segs}<text x="${L + span + 8}" y="${y + 14}" class="val">n=${total}</text>`;
  }).join("");
  const legend = kinds.map((k, i) => `
    <rect x="${L + i * 110}" y="${H - 22}" width="10" height="10" fill="${STOP_FILL[k] ?? "#94a3b8"}"/>
    <text x="${L + i * 110 + 15}" y="${H - 13}" class="val">${esc(k)}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Stop reason mix by variant">
    ${body}${legend}</svg>`;
}

/** Payloads carry whole model responses, so they are truncated: the drill-down is
 *  for reading what a run DID, and the sweep database is the full record. */
const PAYLOAD_CHARS = 400;

/** True when a run's stream holds the same seq twice: two executions of the cell were
 *  written under one run id. Three published runs are like this, and the drill-down is
 *  exactly where a reader would otherwise take an interleaved stream for one
 *  execution. Computed from the events in hand rather than queried, because the
 *  report already has them. */
function isCommingled(events: StoredEvent[]): boolean {
  return new Set(events.map(e => e.seq)).size !== events.length;
}

function trajectories(runs: RunRow[], eventsFor: (id: string) => StoredEvent[]): string {
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
    const outcomeLabel = outcome === "passed" ? "Passed" : outcome === "failed" ? "Failed"
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
      <table class="traj"><thead><tr><th>seq</th><th>type</th><th>name</th><th>tokens</th><th>ms</th><th>payload</th></tr></thead>
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
  const providers = [...new Set(runs.map(r => r.provider))];
  // Read the trajectories before closing. The drill-down is part of the report, not
  // an extra: a reader who cannot see what a run did has to take the aggregate on
  // trust, which is the opposite of what this harness is for.
  const eventsByRun = new Map(runs.map(r => [r.id, store.eventsForRun(r.id)]));
  store.close();

  const judgeRan = rows.some(r => r.sourceCheatRate !== null);
  const scoredRuns = runs.filter(r => r.passed !== null);
  const passedRuns = scoredRuns.filter(r => r.passed === 1).length;
  const overallPassRate = scoredRuns.length ? passedRuns / scoredRuns.length : 0;
  const totalCost = runs.reduce((sum, r) => sum + r.costUsd, 0);
  const totalReasoning = runs.reduce((sum, r) => sum + r.reasoningTokens, 0);
  const integrityFlags = runs.filter(r => r.tampered || r.sourceCheat).length;
  const table = rows.map(r => `<tr>
    <td>${esc(r.variant)}</td><td>${esc(r.provider)}/${esc(r.model)}</td><td>${esc(r.effort)}</td>
    <td>${(r.passRate * 100).toFixed(0)}%</td>
    <td>[${(r.ci.lo * 100).toFixed(0)}, ${(r.ci.hi * 100).toFixed(0)}]</td>
    <td>${(r.tamperRate * 100).toFixed(0)}%</td>
    <td>${r.meanSteps.toFixed(1)}</td>
    <td>${Math.round(r.meanReasoning)}</td>
    <td>$${r.meanCost.toFixed(4)}</td>
    <td>${r.refusals}/${r.errors}</td>
    ${judgeRan ? `<td>${r.sourceCheatRate === null ? "—" : (r.sourceCheatRate * 100).toFixed(0) + "%"}</td>` : ""}
  </tr>`).join("");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Eval Harness | Evaluation Report</title>
<style>
 :root{color-scheme:light;--ink:#17191d;--muted:#616874;--line:#d9dde4;--soft:#f3f5f7;--paper:#fff;--pass:${PASS_FILL};--tamper:${TAMPER_FILL};--accent:#e9a923;--success:#16815c}
 *{box-sizing:border-box;letter-spacing:0}
 html{scroll-behavior:smooth;scroll-padding-top:4.5rem}
 body{margin:0;background:#f7f8fa;color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
 button,input,select{font:inherit;letter-spacing:0}
 a{color:inherit}
 .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
 .masthead{background:#17191d;color:#fff;border-bottom:4px solid var(--accent)}
 .masthead-inner{max-width:1180px;min-width:0;margin-inline:auto;padding:3rem 1.5rem 2.75rem;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2rem;align-items:end}
 .eyebrow{margin:0 0 .55rem;color:#f0bf58;font-size:12px;font-weight:750;text-transform:uppercase}
 h1{max-width:760px;margin:0;font-size:42px;line-height:1.05;font-weight:780;text-wrap:balance}
 .lede{max-width:670px;margin:.85rem 0 0;color:#cdd1d8;font-size:17px;text-wrap:pretty}
 .masthead-meta{display:grid;gap:.35rem;min-width:170px;padding-inline-start:1.25rem;border-inline-start:1px solid #41454e;color:#cdd1d8}
 .masthead-meta strong{color:#fff;font-size:24px;line-height:1.15}
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
 .chart-frame .bar{fill:var(--pass)}.chart-frame .tamper{fill:var(--tamper)}.chart-frame .dot{fill:var(--pass);opacity:.48}
 .chart-frame .ci{stroke:var(--ink);stroke-width:2}.chart-frame .axis{stroke:#6b7280}.chart-frame .grid{stroke:#d9dee7;stroke-dasharray:3 4}
 .chart-frame .lbl{font:600 13px system-ui,-apple-system,"Segoe UI",sans-serif;fill:var(--ink)}
 .chart-frame .val{font:12px system-ui,-apple-system,"Segoe UI",sans-serif;fill:var(--muted)}
 .chart-frame .bar,.chart-frame .tamper,.chart-frame .dot{transition:opacity .16s ease,filter .16s ease}
 .chart-frame .bar:hover,.chart-frame .tamper:hover,.chart-frame .dot:hover{filter:brightness(.82);opacity:1}
 .legend{display:flex;flex-wrap:wrap;gap:.75rem 1.25rem;margin:0;padding:.85rem 1.2rem 0;color:var(--muted);font-size:12px}
 .legend span{display:inline-flex;align-items:center;gap:.45rem}.swatch{width:20px;height:5px;background:var(--pass)}.swatch-tamper{background:var(--tamper)}
 .chart-grid{min-width:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,500px),1fr));gap:1rem}
 .table-scroll{width:100%;overflow:auto;scrollbar-gutter:stable;overscroll-behavior-inline:contain}
 .compare-scroll{margin-top:1rem;background:var(--paper);border:1px solid var(--line);border-radius:6px}
 table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
 th,td{padding:.72rem .8rem;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
 th{background:#eef1f4;color:#454b55;font-size:11px;font-weight:780;text-transform:uppercase;white-space:nowrap}
 tbody tr:last-child td{border-bottom:0}tbody tr:hover td{background:#f8fafc}
 .method-note{max-width:860px;margin:1rem 0 0;color:var(--muted);font-size:12px;text-wrap:pretty}
 .run-tools{display:flex;flex-wrap:wrap;gap:.75rem;align-items:end;margin:0 0 1rem;padding:1rem;background:#eef1f4;border:1px solid var(--line);border-radius:6px}
 .field{display:grid;gap:.3rem;flex:1 1 260px;min-width:0}.field-filter{flex:0 1 190px}
 .control-label{color:#454b55;font-size:11px;font-weight:780;text-transform:uppercase}
 input,select,button{min-height:40px;border:1px solid #aeb5c0;border-radius:4px;background:#fff;color:var(--ink)}
 input,select{width:100%;padding:.5rem .7rem}input:focus,select:focus,button:focus-visible{outline:3px solid rgba(37,99,235,.22);outline-offset:1px;border-color:var(--pass)}
 button{padding:.5rem .8rem;font-weight:700;cursor:pointer}button:hover{background:#e4e8ed}
 .run-count{margin:0 0 0 auto;padding:.55rem 0;color:var(--muted);font-size:13px;white-space:nowrap}
 .run-list{border-top:1px solid var(--line)}
 details.run{background:var(--paper);border-bottom:1px solid var(--line);content-visibility:auto;contain-intrinsic-size:auto 58px}
 details.run[open]{border-inline-start:4px solid var(--accent)}
 details.run>summary{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.5rem 1rem;align-items:center;min-height:58px;padding:.8rem 1rem;cursor:pointer;list-style:none}
 details.run>summary::-webkit-details-marker{display:none}details.run>summary::before{content:"+";grid-column:2;grid-row:1;color:var(--muted);font:700 18px/1 ui-monospace,SFMono-Regular,Consolas,monospace}
 details.run[open]>summary::before{content:"-"}details.run>summary:hover{background:#f5f7f9}
 .run-summary-main{display:flex;flex-wrap:wrap;gap:.45rem;align-items:center;min-width:0}.run-id{min-width:0;overflow-wrap:anywhere;font:650 13px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
 .run-summary-meta{grid-column:2;grid-row:2;display:flex;justify-content:flex-end;gap:.8rem;color:var(--muted);font:12px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace}
 .status{display:inline-flex;align-items:center;min-height:22px;padding:.15rem .45rem;border-radius:3px;font-size:11px;font-weight:750}
 .status-passed{background:#e3f4ec;color:#096444}.status-failed,.status-error{background:#fbe8e7;color:#9e2525}.status-refusal{background:#e8ebef;color:#4f5661}.status-warning{background:#fff0c9;color:#74520a}
 details.run>.note{margin:0 1rem 1rem}
 table.traj{min-width:850px;font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;table-layout:fixed}
 table.traj th:nth-child(1){width:54px}table.traj th:nth-child(2){width:110px}table.traj th:nth-child(3){width:130px}table.traj th:nth-child(4){width:130px}table.traj th:nth-child(5){width:75px}
 table.traj td{vertical-align:top;overflow-wrap:anywhere}table.traj .num{text-align:right;white-space:nowrap}table.traj code{color:#313640;white-space:pre-wrap}
 [hidden]{display:none!important}
 @media (max-width:720px){.masthead-inner{grid-template-columns:minmax(0,1fr);padding:2.25rem 1rem 2rem}h1{font-size:34px}.lede{font-size:15px}.masthead-meta{grid-template-columns:auto minmax(0,1fr);min-width:0;padding:1rem 0 0;border-inline-start:0;border-top:1px solid #41454e}.section-nav-inner,.report-shell{padding-inline:1rem}.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.report-section{padding-block:2.4rem}.section-heading{grid-template-columns:32px minmax(0,1fr);gap:.75rem}.section-index{width:30px;height:30px}h2{font-size:22px}.chart-frame svg{min-width:620px}.run-count{width:100%;margin:0}details.run>summary{grid-template-columns:minmax(0,1fr) 20px}}
 @media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}.chart-frame *{transition:none!important}}
 @media print{.section-nav,.run-tools{display:none}.masthead{background:#fff;color:#000;border-bottom:2px solid #000}.lede,.masthead-meta{color:#333}.report-shell{max-width:none}.report-section{break-inside:avoid}.chart-surface{border-color:#bbb}}
</style>
 </head>
<body>
<header class="masthead"><div class="masthead-inner">
 <div><p class="eyebrow">Evaluation report</p><h1>Agent Eval Harness</h1>
  <p class="lede">Performance, cost, and integrity across recorded coding-agent runs.</p></div>
 <div class="masthead-meta"><strong>${runs.length}</strong><span>recorded runs<br>across ${rows.length} variants</span></div>
 <span class="sr-only">${runs.length} runs across ${rows.length} variants.</span>
</div></header>
<nav class="section-nav" aria-label="Report sections"><div class="section-nav-inner">
 <a href="#overview">Overview</a><a href="#quality">Quality</a><a href="#efficiency">Efficiency</a>
 <a href="#behaviour">Behaviour</a><a href="#runs">Runs</a>
</div></nav>
<main class="report-shell">
<section id="overview" class="report-section summary-section" aria-labelledby="overview-title">
 <h2 id="overview-title" class="sr-only">Overview</h2>
 <dl class="metric-grid" aria-label="Report summary">
  <div class="metric"><dt>Recorded runs</dt><dd>${runs.length}</dd><small>${rows.length} variants</small></div>
  <div class="metric"><dt>Overall pass rate</dt><dd>${(overallPassRate * 100).toFixed(0)}%</dd><small>${passedRuns} of ${scoredRuns.length} scored runs</small></div>
  <div class="metric"><dt>Total API cost</dt><dd>$${totalCost.toFixed(3)}</dd><small>from recorded usage</small></div>
  <div class="metric"><dt>Reasoning tokens</dt><dd>${Math.round(totalReasoning).toLocaleString("en-US")}</dd><small>agent total</small></div>
  <div class="metric"><dt>Integrity flags</dt><dd>${integrityFlags}</dd><small>tamper or judged cheat</small></div>
 </dl>
 ${providers.length === 1
  ? `<p class="note">This is a single-vendor sweep (<strong>${esc(providers[0]!)}</strong>). Effort and tool findings have not been shown to generalise across vendors.</p>`
  : ""}
</section>
<section id="quality" class="report-section" aria-labelledby="quality-title">
 <header class="section-heading"><span class="section-index" aria-hidden="true">01</span><div>
  <h2 id="quality-title">Pass rate and tamper rate by variant</h2>
  <p>Bootstrap 95% confidence intervals keep the uncertainty visible beside each result.</p>
 </div></header>
 <figure class="chart-surface">
  <figcaption class="legend"><span><i class="swatch" aria-hidden="true"></i>Pass rate with 95% CI</span>
   <span><i class="swatch swatch-tamper" aria-hidden="true"></i>Tamper rate on the same axis</span></figcaption>
  <div class="chart-frame">${passAndTamperChart(rows)}</div>
 </figure>
 <div class="table-scroll compare-scroll" role="region" aria-label="Variant comparison" tabindex="0">
 <table><thead><tr><th>Variant</th><th>Model</th><th>Effort</th><th>Pass</th><th>95% CI</th><th>Tamper</th>
  <th>Steps</th><th>Reasoning tok</th><th>Cost/run</th><th>Refus/Err</th>${judgeRan ? "<th>Source cheat</th>" : ""}</tr></thead>
  <tbody>${table}</tbody></table></div>
 <p class="method-note">Refusals and harness errors, including a scorer that never produced a verdict, are excluded from pass-rate denominators and shown separately. Cost comes from actual usage fields.</p>
</section>

<section id="efficiency" class="report-section" aria-labelledby="efficiency-title">
 <header class="section-heading"><span class="section-index" aria-hidden="true">02</span><div>
  <h2 id="efficiency-title">Efficiency</h2><p>Pass rate against the two resources each run consumes: money and reasoning.</p>
 </div></header>
 <div class="chart-grid">
  <figure class="chart-surface"><figcaption class="figure-head"><h3>Cost against pass rate</h3><p>Mean cost per run, one point per variant.</p></figcaption>
   <div class="chart-frame">${scatter(rows, r => r.meanCost, "mean cost per run (USD)", v => "$" + v.toFixed(4),
     "Cost against pass rate, one point per variant")}</div></figure>
  <figure class="chart-surface"><figcaption class="figure-head"><h3>Reasoning tokens against pass rate</h3><p>The effort ladder moves both axes at once.</p></figcaption>
   <div class="chart-frame">${scatter(rows, r => r.meanReasoning, "mean reasoning tokens per run", v => v.toFixed(0),
     "Reasoning tokens against pass rate, one point per variant")}</div></figure>
 </div>
</section>

<section id="behaviour" class="report-section" aria-labelledby="behaviour-title">
 <header class="section-heading"><span class="section-index" aria-hidden="true">03</span><div>
  <h2 id="behaviour-title">Run behaviour</h2><p>How long agents worked and why their runs stopped.</p>
 </div></header>
 <div class="chart-grid">
  <figure class="chart-surface"><figcaption class="figure-head"><h3>Step count distribution</h3><p>One dot per run, with the median marked.</p></figcaption>
   <div class="chart-frame">${stepDistribution(rows)}</div></figure>
  <figure class="chart-surface"><figcaption class="figure-head"><h3>Outcome mix</h3><p>Completed, capped, refused, and errored runs by variant.</p></figcaption>
   <div class="chart-frame">${stopStack(rows)}</div></figure>
 </div>
${judgeRan
  ? `<p class="note">Source cheat rate is the share of <em>passing</em> runs — the only ones
     judged, and the only denominator here — where the LLM judge (stretch, opt-in
     <code>--judge</code>) found the patch games the specific test: hardcodes, special-cases,
     or mocks the unit under test, rather than fixing the general behaviour. Judged by
     <strong>${esc(JUDGE_MODEL)}</strong>, a model distinct from every model under test.
     That judge call is billed: its cost is included in Cost/run above, though its
     tokens are not in the token columns, which count the agent only.</p>`
  : ""}
</section>
<section id="runs" class="report-section" aria-labelledby="runs-title">
 <header class="section-heading"><span class="section-index" aria-hidden="true">04</span><div>
  <h2 id="runs-title">Trajectory drill-down</h2><p>Every recorded LLM call, tool call, result, and per-turn token count. Payload previews stop at ${PAYLOAD_CHARS} characters; the database retains the full record.</p>
 </div></header>
 <div class="run-tools" aria-label="Trajectory controls">
  <label class="field"><span class="control-label">Search runs</span><input id="run-search" type="search" placeholder="Run ID, variant, model..." autocomplete="off"></label>
  <label class="field field-filter"><span class="control-label">Outcome</span><select id="run-filter">
   <option value="all">All outcomes</option><option value="passed">Passed</option><option value="failed">Failed</option>
   <option value="error">Errors</option><option value="refusal">Refusals</option><option value="tampered">Tampered</option><option value="cheated">Judged cheats</option>
  </select></label>
  <button type="button" id="expand-runs">Expand visible</button><button type="button" id="collapse-runs">Collapse all</button>
  <p id="run-count" class="run-count" aria-live="polite">${runs.length} of ${runs.length} runs</p>
 </div>
 <div id="run-list" class="run-list">${trajectories(runs, id => eventsByRun.get(id) ?? [])}</div>
</section>
</main>
<script>
 (() => {
  const search = document.querySelector("#run-search");
  const filter = document.querySelector("#run-filter");
  const count = document.querySelector("#run-count");
  const items = [...document.querySelectorAll("details.run")];
  const applyFilters = () => {
   const query = search.value.trim().toLowerCase();
   const selected = filter.value;
   let visible = 0;
   for (const item of items) {
    const matchesText = item.dataset.search.includes(query);
    const matchesView = selected === "all" || item.dataset.outcome === selected
      || item.dataset.flags.split(" ").includes(selected);
    item.hidden = !(matchesText && matchesView);
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
