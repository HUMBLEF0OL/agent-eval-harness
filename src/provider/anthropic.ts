import Anthropic from "@anthropic-ai/sdk";
import type {
  Effort, Provider, Session, SessionConfig, Step, StopReason,
  ToolCall, ToolResult, ToolSpec, UsageTotals,
} from "../types.js";

// Lazy: importing this module must not require ANTHROPIC_API_KEY.
let _client: Anthropic | undefined;
const client = () => (_client ??= new Anthropic());

type Res = Anthropic.Message;

export function mapTools(tools: ToolSpec[]) {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as any,     // Anthropic keys the schema differently
  }));
}

export function normaliseUsage(res: Res): UsageTotals {
  const u = res.usage;
  return {
    // Already the uncached remainder. Subtracting cache_read here would double-discount.
    inputTokens:      u.input_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens:  u.cache_read_input_tokens ?? 0,
    outputTokens:     u.output_tokens,
    reasoningTokens:  0,                   // thinking tokens are inside output_tokens
  };
}

export function mapStop(res: Res): StopReason {
  switch (res.stop_reason) {
    case "end_turn":   return "end_turn";
    case "tool_use":   return "tool_use";
    case "max_tokens": return "max_tokens";
    case "refusal":    return "refusal";
    default:
      // pause_turn cannot occur without server-side tools; never silently continue.
      throw new Error(`unhandled Anthropic stop_reason: ${res.stop_reason}`);
  }
}

export function extractToolCalls(res: Res): ToolCall[] {
  return (res.content as any[])
    .filter(b => b.type === "tool_use")
    .map(b => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));
}

export function buildToolResultMessage(results: ToolResult[]) {
  return {
    role: "user" as const,
    content: results.map(r => ({
      type: "tool_result" as const,
      tool_use_id: r.id,
      content: r.content,
      ...(r.isError ? { is_error: true } : {}),
    })),
  };
}

function textOf(res: Res): string {
  return (res.content as any[]).filter(b => b.type === "text").map(b => b.text).join("");
}

function buildSystem(prompt: string) {
  return [{ type: "text" as const, text: prompt, cache_control: { type: "ephemeral" as const } }];
}

/** effort -> extended-thinking budget. CHECKED against the installed SDK, no key
 *  required: @anthropic-ai/sdk@0.70.1's MessageCreateParams has NO `output_config`
 *  and no `effort` field anywhere — grepping every .d.ts under node_modules/
 *  @anthropic-ai/sdk for `output_config` or `effort` returns ZERO hits, so the
 *  previous `output_config: { effort }` was an invented field that only compiled
 *  because the whole request object was cast `as any`. A reviewer's finding, now
 *  confirmed rather than suspected.
 *
 *  What the installed types DO expose, verbatim from resources/messages/messages.d.ts:
 *      thinking?: ThinkingConfigParam;
 *      export type ThinkingConfigParam = ThinkingConfigEnabled | ThinkingConfigDisabled;
 *      export interface ThinkingConfigEnabled { budget_tokens: number; type: 'enabled'; }
 *      export interface ThinkingConfigDisabled { type: 'disabled'; }
 *  with the doc comment on budget_tokens: "Must be ≥1024 and less than `max_tokens`."
 *
 *  So the neutral ladder maps onto budget_tokens here — the adapter's job, exactly
 *  as the Google adapter maps effort onto thinkingBudget. The numbers match that
 *  adapter's ladder so the two vendors' arms mean the same thing.
 *
 *  Two constraints from the type's own doc, both enforced below:
 *   - budget < max_tokens. Thinking is spent out of max_tokens, so half the turn's
 *     cap is the reserve (same reasoning, and same ceiling, as google.ts: under a
 *     16000-token cap high and xhigh clamp to the same number).
 *   - budget >= 1024, or the API rejects it. A cap under 2048 therefore cannot host
 *     thinking at all, so it is DISABLED rather than sent as an illegal budget —
 *     which is also what prewarm needs (max_tokens 1, nothing to think about). */
const THINKING_BUDGET: Record<Effort, number> = {
  low: 1024, medium: 4096, high: 16384, xhigh: 24576,
};

export function thinkingFor(effort: Effort, maxTokens: number): Anthropic.ThinkingConfigParam {
  const budget = Math.min(THINKING_BUDGET[effort], Math.floor(maxTokens / 2));
  return budget >= 1024 ? { type: "enabled", budget_tokens: budget } : { type: "disabled" };
}

/** Breakpoints 2 and 3 of TSD §6.1. What this actually does: marks the LAST
 *  content block of the last message, and — when there are at least 4 messages —
 *  the last content block of the 4th-from-last MESSAGE. Messages, not blocks:
 *  four messages is roughly two agent turns back, which is the older-prefix
 *  breakpoint. It is not a 15-block offset and makes no claim about the API's
 *  20-block lookback window.
 *
 *  A thinking block can never carry cache_control (the Messages API rejects it),
 *  so a target that lands on one is skipped rather than marked. */
function withCacheBreakpoints(messages: any[]): any[] {
  const out = messages.map(m => ({ ...m, content: Array.isArray(m.content) ? [...m.content] : m.content }));
  const mark = (i: number) => {
    const m = out[i];
    if (!m || !Array.isArray(m.content) || m.content.length === 0) return;
    const last = m.content.length - 1;
    const target = m.content[last];
    if (target?.type === "thinking" || target?.type === "redacted_thinking") return;
    m.content[last] = { ...target, cache_control: { type: "ephemeral" } };
  };
  mark(out.length - 1);
  if (out.length >= 4) mark(out.length - 4);
  return out;
}

class AnthropicSession implements Session {
  private messages: any[];

  constructor(private cfg: SessionConfig, task: string) {
    this.messages = [{ role: "user", content: [{ type: "text", text: task }] }];
  }

  async step(results: ToolResult[] | null): Promise<Step> {
    // ALL results in ONE user message — the exact opposite of OpenAI.
    if (results) this.messages.push(buildToolResultMessage(results));

    // No `as any` on this request any more: every field is one the installed
    // SDK's MessageCreateParams actually declares, so the compiler checks the
    // shape from now on and an invented field is a build error, not a live 400.
    const res = await client().messages.create({
      model: this.cfg.model,
      max_tokens: this.cfg.maxTokensPerTurn,
      thinking: thinkingFor(this.cfg.effort, this.cfg.maxTokensPerTurn),
      system: buildSystem(this.cfg.systemPrompt),
      tools: mapTools(this.cfg.tools),
      messages: withCacheBreakpoints(this.messages),
    });

    // The ENTIRE content array, thinking blocks included — signatures must round-trip.
    this.messages.push({ role: "assistant", content: res.content });

    return {
      stop: mapStop(res),
      text: textOf(res),
      toolCalls: extractToolCalls(res),
      usage: normaliseUsage(res),
      raw: res,
    };
  }
}

export const anthropicProvider: Provider = {
  id: "anthropic",
  // cache_control breakpoints are placed by this adapter (§6.1), so a warm
  // prefix reads reliably: one completed run reporting zero is a real failure.
  cacheMode: "explicit",
  start: (cfg, task) => new AnthropicSession(cfg, task),
  async complete(cfg, prompt, schema) {
    // `output_config.format` was the other half of the same invented field: the
    // installed SDK has no structured-output parameter at all (no `format`, no
    // `response_format`, no `json_schema` anywhere in its types). The typed
    // mechanism it does have is a FORCED tool call — the schema becomes the
    // tool's input_schema and the reply comes back as tool_use input, already an
    // object, so there is nothing to JSON.parse and no prose to strip.
    // Thinking must be disabled: forced tool use and extended thinking are
    // mutually exclusive, and an audit call this small has nothing to think about.
    const TOOL = "emit_verdict";
    const res = await client().messages.create({
      model: cfg.model,
      max_tokens: 2000,
      thinking: { type: "disabled" },
      tools: [{ name: TOOL, description: "Return the verdict as structured data.", input_schema: schema as any }],
      tool_choice: { type: "tool", name: TOOL },
      messages: [{ role: "user", content: prompt }],
    });
    const call = extractToolCalls(res)[0];
    // The caller validates the verdict's fields; this only guarantees it got an
    // object at all, rather than handing `undefined` down the line.
    if (!call) throw new Error(`Anthropic complete returned no ${TOOL} tool_use block: ${textOf(res)}`);
    return { value: call.input, usage: normaliseUsage(res) };
  },
  async prewarm(cfg) {
    const res = await client().messages.create({
      model: cfg.model,
      max_tokens: 1,          // the Messages API requires >= 1; 0 is a 400 on the FIRST call of a sweep
      thinking: { type: "disabled" },   // nothing to think about, and a budget must be < max_tokens
      system: buildSystem(cfg.systemPrompt),
      tools: mapTools(cfg.tools),
      messages: [{ role: "user", content: "warmup" }],
    });
    return normaliseUsage(res);
  },
};
