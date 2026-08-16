import { accumulate, zeroUsage } from "./cost.js";
import type {
  EventInput, Provider, SessionConfig, Step, ToolHandlers, ToolResult, UsageTotals,
} from "./types.js";

export interface LoopConfig extends SessionConfig { maxSteps: number }

export interface LoopResult {
  stop: "end_turn" | "max_steps" | "max_tokens" | "refusal" | "error";
  steps: number;
  usage: UsageTotals;
  error?: string;
}

// No vendor SDK import here, ever — see TSD §1.1 and scripts/check-leaks.mjs.
export async function runLoop(
  provider: Provider,
  cfg: LoopConfig,
  task: string,
  tools: ToolHandlers,
  emit: (e: EventInput) => void,
): Promise<LoopResult> {
  const session = provider.start(cfg, task);
  const totals = zeroUsage();
  let results: ToolResult[] | null = null;
  let seq = 0;

  for (let step = 0; step < cfg.maxSteps; step++) {
    emit({ seq: seq++, type: "llm_call", payload: { step } });

    let s: Step;
    const t0 = Date.now();
    try {
      s = await session.step(results);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ seq: seq++, type: "error", payload: { message } });
      return { stop: "error", steps: step, usage: totals, error: message };
    }

    accumulate(totals, s.usage);   // every turn, not just the last
    emit({
      seq: seq++, type: "llm_response",
      payload: { stop: s.stop, text: s.text, raw: s.raw },
      usage: s.usage, latencyMs: Date.now() - t0,
    });

    // Branch on stop BEFORE reading content — a refusal has none.
    if (s.stop === "refusal")    return { stop: "refusal",    steps: step + 1, usage: totals };
    if (s.stop === "max_tokens") return { stop: "max_tokens", steps: step + 1, usage: totals };
    if (s.stop === "end_turn")   return { stop: "end_turn",   steps: step + 1, usage: totals };

    results = [];
    for (const tc of s.toolCalls) {
      emit({ seq: seq++, type: "tool_call", name: tc.name, payload: tc.input });
      const out = tc.parseError
        ? { content: `invalid tool arguments: ${tc.parseError}`, isError: true }
        : await tools.dispatch(tc.name, tc.input);
      emit({ seq: seq++, type: "tool_result", name: tc.name, payload: out });
      results.push({ id: tc.id, content: out.content, isError: out.isError });
    }
  }

  return { stop: "max_steps", steps: cfg.maxSteps, usage: totals };
}
