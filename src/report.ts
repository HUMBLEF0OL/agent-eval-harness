import * as fs from "node:fs";
import { openStore, type RunRow } from "./store.js";

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
  stopCounts: Record<string, number>;
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
      meanReasoning: mean(rs.map(r => r.reasoningTokens)),
      stopCounts,
    };
  }).sort((a, b) => a.variant.localeCompare(b.variant));
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function barChart(rows: VariantSummary[]): string {
  const W = 700, H = 40 * rows.length + 40, L = 150;
  const bars = rows.map((r, i) => {
    const y = 20 + i * 40, w = (W - L - 60) * r.passRate;
    const lo = (W - L - 60) * r.ci.lo, hi = (W - L - 60) * r.ci.hi;
    return `
      <text x="${L - 8}" y="${y + 16}" text-anchor="end" class="lbl">${esc(r.variant)}</text>
      <rect x="${L}" y="${y}" width="${w}" height="22" class="bar"/>
      <line x1="${L + lo}" x2="${L + hi}" y1="${y + 11}" y2="${y + 11}" class="ci"/>
      <line x1="${L + lo}" x2="${L + lo}" y1="${y + 4}" y2="${y + 18}" class="ci"/>
      <line x1="${L + hi}" x2="${L + hi}" y1="${y + 4}" y2="${y + 18}" class="ci"/>
      <text x="${L + Math.max(w, hi) + 8}" y="${y + 16}" class="val">${(r.passRate * 100).toFixed(0)}% (n=${r.scored})</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Pass rate by variant">${bars}</svg>`;
}

export function buildReport(dbPath: string, outPath: string): void {
  const store = openStore(dbPath);
  const runs = store.allRuns();
  const rows = summarise(runs);
  const providers = [...new Set(runs.map(r => r.provider))];
  store.close();

  const table = rows.map(r => `<tr>
    <td>${esc(r.variant)}</td><td>${esc(r.provider)}/${esc(r.model)}</td><td>${esc(r.effort)}</td>
    <td>${(r.passRate * 100).toFixed(0)}%</td>
    <td>[${(r.ci.lo * 100).toFixed(0)}, ${(r.ci.hi * 100).toFixed(0)}]</td>
    <td>${(r.tamperRate * 100).toFixed(0)}%</td>
    <td>${r.meanSteps.toFixed(1)}</td>
    <td>${Math.round(r.meanReasoning)}</td>
    <td>$${r.meanCost.toFixed(4)}</td>
    <td>${r.refusals}/${r.errors}</td>
  </tr>`).join("");

  const html = `<!doctype html><meta charset="utf-8"><title>Agent Eval Harness</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#111}
 table{border-collapse:collapse;width:100%;margin:1rem 0}
 th,td{border-bottom:1px solid #ddd;padding:.4rem .5rem;text-align:left}
 .bar{fill:#2563eb}.ci{stroke:#111;stroke-width:2}.lbl{font:13px system-ui}.val{font:12px system-ui;fill:#555}
 .note{background:#fff8e1;border-left:3px solid #f59e0b;padding:.6rem .8rem;margin:1rem 0}
</style>
<h1>Agent Eval Harness</h1>
<p>${runs.length} runs across ${rows.length} variants.</p>
${providers.length === 1
  ? `<p class="note">Single-vendor sweep (<strong>${esc(providers[0]!)}</strong>). Effort and tool findings below have not been shown to generalise across vendors.</p>`
  : ""}
<h2>Pass rate by variant (bootstrap 95% CI)</h2>
${barChart(rows)}
<table>
 <tr><th>Variant</th><th>Model</th><th>Effort</th><th>Pass</th><th>95% CI</th><th>Tamper</th>
     <th>Steps</th><th>Reasoning tok</th><th>Cost/run</th><th>Refus/Err</th></tr>
 ${table}
</table>
<p><small>Refusals and harness errors are excluded from pass-rate denominators and shown
separately. Cost is computed from actual usage fields, not estimated.</small></p>`;

  fs.writeFileSync(outPath, html, "utf8");
  console.log(`wrote ${outPath} (${rows.length} variants, ${runs.length} runs)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildReport(process.argv[2] ?? "./eval.db", process.argv[3] ?? "./report.html");
}
