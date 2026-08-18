import OpenAI from "openai";
import { costUsd, maxOpenAIRequestCostUsd } from "../cost.js";
import type {
  Provider, Session, SessionConfig, Step, StopReason,
  ToolCall, ToolResult, ToolSpec, UsageTotals,
} from "../types.js";

// reads OPENAI_API_KEY. The SDK's constructor throws synchronously if no key
// is present at all (openai@6.9.0), even though this module's pure helpers
// (mapTools/normaliseUsage/mapStop/extractToolCalls) never need a client —
// the placeholder fallback keeps `import`able in a no-credentials environment
// without ever being used for a real call.
const client = new OpenAI({
  apiKey: process.env["OPENAI_API_KEY"] ?? "sk-no-key-set",
  maxRetries: 0,
});

type Res = OpenAI.Responses.Response;

async function budgetedResponse(
  cfg: SessionConfig,
  maxOutputTokens: number,
  dispatch: () => Promise<Res>,
): Promise<{ res: Res; usage: UsageTotals }> {
  const budget = cfg.liveBudget;
  if (!budget) {
    const res = await dispatch();
    return { res, usage: normaliseUsage(res) };
  }

  const estimate = maxOpenAIRequestCostUsd(cfg.model, maxOutputTokens);
  const reservation = budget.tryReserve(estimate);
  if (!reservation) {
    const { remainingUsd } = budget.snapshot();
    throw new Error(
      `live budget exhausted: request needs up to $${estimate.toFixed(6)}, ` +
      `but only $${remainingUsd.toFixed(6)} remains`,
    );
  }

  let res: Res;
  try {
    res = await dispatch();
  } catch (error) {
    reservation.quarantine();
    throw error;
  }

  try {
    const usage = normaliseUsage(res);
    const observedTokens = usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens
      + usage.outputTokens;
    if (observedTokens === 0) reservation.quarantine();
    else reservation.settle(costUsd(cfg.model, usage));
    return { res, usage };
  } catch (error) {
    reservation.quarantine();
    throw error;
  }
}

export function mapTools(tools: ToolSpec[]) {
  return tools.map(t => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: true,        // legal because every schema sets additionalProperties:false
  }));
}

export function normaliseUsage(res: Res): UsageTotals {
  const u = res.usage;
  if (!u) throw new Error("OpenAI response carried no usage — cannot account for this turn");
  const cacheRead = u.input_tokens_details?.cached_tokens ?? 0;
  return {
    // input_tokens INCLUDES cached_tokens. Anthropic's does not. This line is the
    // single highest-value assertion in the provider layer.
    inputTokens:      u.input_tokens - cacheRead,
    cacheWriteTokens: 0,                       // billed at 1.25x but not reported — TSD §7.4
    cacheReadTokens:  cacheRead,
    outputTokens:     u.output_tokens,
    reasoningTokens:  u.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

export function mapStop(res: Res): StopReason {
  // Order matters: an incomplete response can still contain a truncated function_call.
  if (res.status === "incomplete") {
    return res.incomplete_details?.reason === "content_filter" ? "refusal" : "max_tokens";
  }
  const refused = res.output.some(
    (o: any) => o.type === "message" && o.content?.some((c: any) => c.type === "refusal"),
  );
  if (refused) return "refusal";
  if (res.output.some((o: any) => o.type === "function_call")) return "tool_use";
  return "end_turn";
}

export function extractToolCalls(res: Res): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const item of res.output as any[]) {
    if (item.type !== "function_call") continue;
    let input: Record<string, unknown> = {};
    let parseError: string | undefined;
    try { input = JSON.parse(item.arguments || "{}"); }
    catch (e) { parseError = (e as Error).message; }
    calls.push({ id: item.call_id, name: item.name, input, ...(parseError ? { parseError } : {}) });
  }
  return calls;
}

function textOf(res: Res): string {
  return (res.output as any[])
    .filter(o => o.type === "message")
    .flatMap(o => o.content ?? [])
    .filter((c: any) => c.type === "output_text")
    .map((c: any) => c.text)
    .join("");
}

class OpenAISession implements Session {
  /** Private, native. The loop never sees this (TSD §2.2). */
  private input: any[];

  constructor(private cfg: SessionConfig, task: string) {
    this.input = [{ role: "user", content: task }];
  }

  async step(results: ToolResult[] | null): Promise<Step> {
    if (results) {
      // ONE item per result, appended separately — the exact opposite of Anthropic.
      for (const r of results) {
        this.input.push({ type: "function_call_output", call_id: r.id, output: r.content });
      }
    }

    const { res, usage } = await budgetedResponse(this.cfg, this.cfg.maxTokensPerTurn, async () =>
      await client.responses.create({
      model: this.cfg.model,
      instructions: this.cfg.systemPrompt,
      input: this.input,
      tools: mapTools(this.cfg.tools),
      reasoning: { effort: this.cfg.effort },
      max_output_tokens: this.cfg.maxTokensPerTurn,
      store: false,
      include: ["reasoning.encrypted_content"],   // required to carry reasoning with store:false
      prompt_cache_key: this.cfg.cacheKey,
      } as any) as Res,
    );

    // EVERY output item, reasoning included. Dropping reasoning is silent and degrades the agent.
    this.input.push(...(res.output as any[]));

    return {
      stop: mapStop(res),
      text: textOf(res),
      toolCalls: extractToolCalls(res),
      usage,
      raw: res,
    };
  }
}

export const openaiProvider: Provider = {
  id: "openai",
  // prompt_cache_key improves routing affinity but does not guarantee that the
  // first request after a pre-warm hits. A live keyed request missed, so only a
  // sustained window of zero reads is evidence that automatic caching is broken.
  cacheMode: "implicit",
  start: (cfg, task) => new OpenAISession(cfg, task),
  async complete(cfg, prompt, schema) {
    const { res, usage } = await budgetedResponse(cfg, 2000, async () =>
      await client.responses.create({
        model: cfg.model,
        reasoning: { effort: "low" },
        max_output_tokens: 2000,
        store: false,
        input: prompt,
        text: { format: { type: "json_schema", name: "verdict", schema, strict: true } },
      } as any) as Res,
    );
    return { value: JSON.parse(textOf(res)), usage };
  },
  async prewarm(cfg) {
    const { usage } = await budgetedResponse(cfg, 16, async () =>
      await client.responses.create({
        model: cfg.model,
        instructions: cfg.systemPrompt,
        input: "warmup",
        tools: mapTools(cfg.tools),
        reasoning: { effort: "low" },
        max_output_tokens: 16,
        store: false,
        prompt_cache_key: cfg.cacheKey,
      } as any) as Res,
    );
    return usage;
  },
};
