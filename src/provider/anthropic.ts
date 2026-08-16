import Anthropic from "@anthropic-ai/sdk";
import type {
  Provider, Session, SessionConfig, Step, StopReason,
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

    const res = await client().messages.create({
      model: this.cfg.model,
      max_tokens: this.cfg.maxTokensPerTurn,
      // UNVERIFIED. `output_config` is NOT in @anthropic-ai/sdk@0.70's MessageCreateParams;
      // it only compiles because the whole object is cast `as any` below, so TypeScript
      // never checks it and no offline test can either. The plan mandates this shape, and
      // it cannot be settled without a live call — ANTHROPIC_API_KEY is unset here.
      // FIRST THING TO CHECK the day a key appears: if the API 400s on an unknown field,
      // this (and the two identical lines in complete/prewarm) is why.
      output_config: { effort: this.cfg.effort },
      system: buildSystem(this.cfg.systemPrompt),
      tools: mapTools(this.cfg.tools),
      messages: withCacheBreakpoints(this.messages),
    } as any) as Res;

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
  start: (cfg, task) => new AnthropicSession(cfg, task),
  async complete(cfg, prompt, schema) {
    const res = await client().messages.create({
      model: cfg.model,
      max_tokens: 2000,
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: prompt }],
    } as any) as Res;
    return { value: JSON.parse(textOf(res)), usage: normaliseUsage(res) };
  },
  async prewarm(cfg) {
    const res = await client().messages.create({
      model: cfg.model,
      max_tokens: 1,          // the Messages API requires >= 1; 0 is a 400 on the FIRST call of a sweep
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      system: buildSystem(cfg.systemPrompt),
      tools: mapTools(cfg.tools),
      messages: [{ role: "user", content: "warmup" }],
    } as any) as Res;
    return normaliseUsage(res);
  },
};
