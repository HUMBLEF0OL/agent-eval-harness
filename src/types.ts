export type Effort = "low" | "medium" | "high" | "xhigh";
export type ProviderId = "openai" | "anthropic" | "google";

/** The cheat judge always runs on this model, never on the model under test
 *  (TSD §9.3). It lives here — the one module that imports nothing — so the
 *  runner and the report can agree on it without the report pulling the
 *  provider registry, and with it both vendor SDKs, into its import graph. */
export const JUDGE_MODEL = "gpt-5-nano";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: false;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  parseError?: string;
}

export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

export interface UsageTotals {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal";

export interface Step {
  stop: StopReason;
  text: string;
  toolCalls: ToolCall[];
  usage: UsageTotals;
  raw: unknown;
}

export interface SessionConfig {
  model: string;
  effort: Effort;
  systemPrompt: string;
  tools: ToolSpec[];
  maxTokensPerTurn: number;
  cacheKey: string;
}

export interface Session {
  step(results: ToolResult[] | null): Promise<Step>;
}

export interface Provider {
  readonly id: ProviderId;
  start(cfg: SessionConfig, task: string): Session;
  prewarm(cfg: SessionConfig): Promise<UsageTotals>;
  /** One-shot structured completion. Used only by the cheat judge (TSD §9.3).
   *  Returns usage alongside the parsed value: this call is billed, and spend
   *  the harness cannot see is spend it reports wrongly. */
  complete(cfg: SessionConfig, prompt: string, schema: object):
    Promise<{ value: unknown; usage: UsageTotals }>;
}

export type EventType =
  | "llm_call" | "llm_response" | "tool_call" | "tool_result" | "error";

export interface EventInput {
  seq: number;
  type: EventType;
  name?: string;
  payload?: unknown;
  usage?: UsageTotals;
  latencyMs?: number;
}

export interface ToolOutput { content: string; isError?: boolean }
export interface ToolHandlers { dispatch(name: string, input: Record<string, unknown>): Promise<ToolOutput> }
