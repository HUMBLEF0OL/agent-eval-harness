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
      <rect x="${L}" y="${y}" width="${w}" height="14" class="bar"/>
      <line x1="${L + lo}" x2="${L + hi}" y1="${y + 7}" y2="${y + 7}" class="ci"/>
      <line x1="${L + lo}" x2="${L + lo}" y1="${y + 1}" y2="${y + 13}" class="ci"/>
      <line x1="${L + hi}" x2="${L + hi}" y1="${y + 1}" y2="${y + 13}" class="ci"/>
      <text x="${L + Math.max(w, hi) + 8}" y="${y + 12}" class="val">${(r.passRate * 100).toFixed(0)}% (n=${r.scored})</text>
      <rect x="${L}" y="${y + 17}" width="${span * r.tamperRate}" height="10" class="tamper"/>
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
    <circle cx="${px(xOf(r))}" cy="${py(r.passRate)}" r="5" class="bar"/>
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
    const dots = r.stepValues.map(v => `<circle cx="${px(v)}" cy="${y + 7}" r="3" class="dot"/>`).join("");
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
    return `<details><summary>${esc(r.id)} &mdash; ${esc(r.stopReason ?? "?")}  passed=${r.passed ?? "NULL"}  tampered=${r.tampered ?? 0}  steps=${r.steps ?? 0}  $${r.costUsd.toFixed(4)}${cheat}${commingled ? "  &#9888; COMMINGLED" : ""}</summary>
      ${commingled ? `<p class="note"><strong>Two executions are stored under this run id.</strong>
        Some seq positions hold events from both, so this is not one unambiguous trajectory.
        Rows are in write order, and a seq that goes <em>backwards</em> marks where the second
        execution's events begin. The run row above came from whichever execution finished
        last, so it may not describe the events you are reading.</p>` : ""}
      ${r.error ? `<p class="note">${esc(r.error)}</p>` : ""}
      ${r.sourceCheatEvidence ? `<p class="note">judge: ${esc(r.sourceCheatEvidence)}</p>` : ""}
      <table class="traj"><tr><th>seq</th><th>type</th><th>name</th><th>tokens</th><th>ms</th><th>payload</th></tr>
      ${rows || `<tr><td colspan="6">no events recorded</td></tr>`}</table></details>`;
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

  const html = `<!doctype html><meta charset="utf-8"><title>Agent Eval Harness</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#111}
 table{border-collapse:collapse;width:100%;margin:1rem 0}
 th,td{border-bottom:1px solid #ddd;padding:.4rem .5rem;text-align:left}
 .bar{fill:${PASS_FILL}}.tamper{fill:${TAMPER_FILL}}.dot{fill:${PASS_FILL};opacity:.45}
 .ci{stroke:#111;stroke-width:2}.axis{stroke:#111}.grid{stroke:#cbd5e1}
 .lbl{font:13px system-ui}.val{font:12px system-ui;fill:#555}
 .note{background:#fff8e1;border-left:3px solid #f59e0b;padding:.6rem .8rem;margin:1rem 0}
 .key{font-size:13px;color:#555}
 details{border-bottom:1px solid #eee;padding:.35rem 0}
 summary{cursor:pointer;font:13px/1.4 ui-monospace,Consolas,monospace}
 table.traj{font:12px/1.35 ui-monospace,Consolas,monospace;table-layout:fixed}
 table.traj td{vertical-align:top;overflow-wrap:anywhere}
 table.traj .num{text-align:right;white-space:nowrap}
</style>
<h1>Agent Eval Harness</h1>
<p>${runs.length} runs across ${rows.length} variants.</p>
${providers.length === 1
  ? `<p class="note">Single-vendor sweep (<strong>${esc(providers[0]!)}</strong>). Effort and tool findings below have not been shown to generalise across vendors.</p>`
  : ""}
<h2>Pass rate and tamper rate by variant (bootstrap 95% CI)</h2>
<p class="key"><span style="color:${PASS_FILL}">&#9644;</span> pass rate, with 95% CI whiskers
&nbsp; <span style="color:${TAMPER_FILL}">&#9644;</span> tamper rate, on the same axis</p>
${passAndTamperChart(rows)}
<table>
 <tr><th>Variant</th><th>Model</th><th>Effort</th><th>Pass</th><th>95% CI</th><th>Tamper</th>
     <th>Steps</th><th>Reasoning tok</th><th>Cost/run</th><th>Refus/Err</th>${judgeRan ? "<th>Source cheat</th>" : ""}</tr>
 ${table}
</table>
<p><small>Refusals and harness errors &mdash; including a scorer that never produced a
verdict &mdash; are excluded from pass-rate denominators and shown separately. Cost is
computed from actual usage fields, not estimated.</small></p>

<h2>Cost against pass rate</h2>
${scatter(rows, r => r.meanCost, "mean cost per run (USD)", v => "$" + v.toFixed(4),
  "Cost against pass rate, one point per variant")}

<h2>Reasoning tokens against pass rate</h2>
<p class="key">Did thinking harder help, and at what price? Read it beside the cost chart:
the effort ladder moves both axes at once.</p>
${scatter(rows, r => r.meanReasoning, "mean reasoning tokens per run", v => v.toFixed(0),
  "Reasoning tokens against pass rate, one point per variant")}

<h2>Step count distribution</h2>
<p class="key">One dot per run, median marked.</p>
${stepDistribution(rows)}

<h2>Outcome mix</h2>
${stopStack(rows)}
${judgeRan
  ? `<p class="note">Source cheat rate is the share of <em>passing</em> runs — the only ones
     judged, and the only denominator here — where the LLM judge (stretch, opt-in
     <code>--judge</code>) found the patch games the specific test: hardcodes, special-cases,
     or mocks the unit under test, rather than fixing the general behaviour. Judged by
     <strong>${esc(JUDGE_MODEL)}</strong>, a model distinct from every model under test.
     That judge call is billed: its cost is included in Cost/run above, though its
     tokens are not in the token columns, which count the agent only.</p>`
  : ""}
<h2>Trajectory drill-down</h2>
<p class="key">Every run: each LLM call, tool call and result, with per-turn tokens. Payloads
are truncated to ${PAYLOAD_CHARS} characters &mdash; the sweep database holds them in full.</p>
${trajectories(runs, id => eventsByRun.get(id) ?? [])}`;

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
