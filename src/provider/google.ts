import { GoogleGenAI } from "@google/genai";
import type {
  Effort, Provider, Session, SessionConfig, Step, StopReason,
  ToolCall, ToolResult, ToolSpec, UsageTotals,
} from "../types.js";

/** Google Gemini adapter.
 *
 *  Three things here are unlike the other two adapters and are the reason this
 *  file exists rather than being folded into one of them:
 *
 *  1. USAGE ARITHMETIC (see normaliseUsage). Gemini is a THIRD distinct shape.
 *     There is one unresolved claim in the wild — a third-party source says that
 *     on the Gemini Developer API `candidatesTokenCount` already INCLUDES the
 *     thinking tokens, while on Vertex it does not. That contradicts the SDK's
 *     own doc comment on `totalTokenCount`, which sums thoughts SEPARATELY from
 *     candidates. No offline evidence settles it, so instead of guessing,
 *     `usageArithmeticHolds` re-derives the documented identity from every real
 *     response and normaliseUsage warns ONCE if it ever fails. That turns a
 *     silent 2x output-token overcount into a loud line on the first live call.
 *
 *     STILL UNANSWERED, and this comment is the record that it is. One live
 *     generateContent with thinking on decides it outright: send any prompt,
 *     read usageMetadata, and see whether `usageArithmeticHolds` is true of it.
 *     Nothing in this repo's gate makes that call and no run of it is recorded
 *     anywhere here. If it comes back "candidates INCLUDES thoughts", delete the
 *     `+ thoughts` in normaliseUsage and flip the outputTokens assertion in
 *     google.test.ts — until then the `+` follows the SDK's own documented
 *     identity, the only evidence that exists.
 *
 *     Commit bc4d657 briefly wrote "SETTLED" here on the strength of three
 *     generateContent calls someone ran by hand outside this gate. That is one
 *     unreproduced hand-run observation, not repo evidence: nothing checked in
 *     reproduces it, and two of the three models it cited exist nowhere else in
 *     this codebase — not in PRICES, not in VARIANTS, not in the TSD. The same
 *     standard that keeps gemini-2.5-pro out of PRICES keeps it out of here, so
 *     the question stays open and the tripwire below stays a tripwire. This
 *     paragraph exists so the claim is not silently re-landed a third time.
 *
 *  2. SELF-THROTTLING (see throttle/withRetry). The free tier is ~10 RPM for
 *     2.5 Flash — below what a single worker generates — so the adapter paces
 *     itself instead of relying on the runner's concurrency setting.
 *
 *  3. A REASONING BUDGET THAT CAN EAT ITS OWN TURN (see thinkingBudgetFor).
 *     Neither other vendor exposes a thinking allowance that can be set larger
 *     than the turn's own output cap; Gemini does, and the runner's cap is
 *     smaller than `high`'s nominal budget, so it must be clamped.
 */

// Lazy: importing this module must not require GEMINI_API_KEY.
let _client: GoogleGenAI | undefined;
const client = () => (_client ??= new GoogleGenAI({ apiKey: process.env["GEMINI_API_KEY"] ?? "no-key-set" }));

type Res = { candidates?: any[]; usageMetadata?: Usage };
type Usage = {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
  totalTokenCount?: number;
};

// ---------------------------------------------------------------- throttling

/** Free-tier Flash is 10 RPM / 250 RPD (AI Studio shows the real number per
 *  account); Flash-Lite is 15 RPM / 1000 RPD. 6500ms is ~9 RPM — just under the
 *  tighter of the two. Override per account with GEMINI_MIN_INTERVAL_MS. */
const minIntervalMs = () => Number(process.env["GEMINI_MIN_INTERVAL_MS"] ?? 6500);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// A real queue, not a naive sleep: each caller chains onto the previous one's
// wait, so N concurrent sessions serialise into N spaced starts instead of all
// firing at once. It gates the START of each request, not its duration — slow
// requests may still overlap, which is fine; RPM counts starts.
let gate: Promise<void> = Promise.resolve();
let lastStartMs = 0;

function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const turn = gate.then(async () => {
    const wait = lastStartMs + minIntervalMs() - Date.now();
    if (wait > 0) await sleep(wait);
    lastStartMs = Date.now();
  });
  gate = turn;
  return turn.then(fn);
}

// -------------------------------------------------------------------- retry

const MAX_ATTEMPTS = 5;

function statusOf(err: any): number {
  return Number(err?.status ?? err?.code ?? err?.response?.status ?? 0);
}

/** Honour the server's own hint when it gives one: a Retry-After header, or the
 *  RetryInfo detail Google embeds in a 429 body as `"retryDelay": "27s"`. */
function retryHintMs(err: any): number | undefined {
  const after = err?.headers?.["retry-after"] ?? err?.response?.headers?.get?.("retry-after");
  if (after !== undefined && after !== null && Number.isFinite(Number(after))) return Number(after) * 1000;
  const m = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(String(err?.message ?? ""));
  return m ? Number(m[1]) * 1000 : undefined;
}

/** The throttle above is a guess at the account's real limit, so it cannot be
 *  the only defence. Retries 429 and 5xx only; anything else (401, 400, a bad
 *  schema) re-throws immediately, and so does the final attempt — the loop must
 *  record stop="error" rather than hang. */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await throttle(fn);
    } catch (err) {
      const status = statusOf(err);
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
      const delay = retryHintMs(err) ?? Math.round(2 ** attempt * 500 * (1 + Math.random()));
      // console.error, not silence: a throttled sweep should look throttled, not slow.
      console.error(`[google] ${label} attempt ${attempt}/${MAX_ATTEMPTS} got ${status}; retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

// ------------------------------------------------------------- pure helpers

export function mapTools(tools: ToolSpec[]) {
  // ONE Tool carrying every declaration — Gemini nests them, unlike the flat
  // tool arrays of the other two APIs.
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as any,
    })),
  }];
}

/** The documented identity from GenerateContentResponseUsageMetadata:
 *  total = prompt + candidates + toolUsePrompt + thoughts. If this holds, then
 *  candidates EXCLUDES thoughts and normaliseUsage must ADD them. If it ever
 *  fails on a real response, the disputed Developer-API behaviour is real and
 *  outputTokens is being double-counted. */
export function usageArithmeticHolds(u: Usage): boolean {
  return (u.totalTokenCount ?? 0) === (u.promptTokenCount ?? 0)
    + (u.candidatesTokenCount ?? 0)
    + (u.toolUsePromptTokenCount ?? 0)
    + (u.thoughtsTokenCount ?? 0);
}

let warnedArithmetic = false;

export function normaliseUsage(res: Res): UsageTotals {
  const u = res.usageMetadata;
  if (!u) throw new Error("Gemini response carried no usageMetadata — cannot account for this turn");

  if (!warnedArithmetic && !usageArithmeticHolds(u)) {
    warnedArithmetic = true;
    console.warn(
      "[google] usageMetadata does not sum as documented (total !== prompt + candidates + toolUsePrompt + thoughts). "
      + "candidatesTokenCount may already include thinking tokens on this API surface, in which case outputTokens "
      + "is double-counting them. Usage: " + JSON.stringify(u),
    );
  }

  const cacheRead = u.cachedContentTokenCount ?? 0;
  const thoughts = u.thoughtsTokenCount ?? 0;
  return {
    // Three vendors, three shapes — this is the contrast the harness exists to keep honest:
    //   OpenAI    — input INCLUDES cached (subtract); output ALREADY INCLUDES reasoning.
    //   Anthropic — input EXCLUDES cached (do NOT subtract); reasoning unreported (0).
    //   Google    — prompt INCLUDES cached (subtract); candidates EXCLUDES thoughts (ADD).
    inputTokens:      (u.promptTokenCount ?? 0) - cacheRead,
    cacheWriteTokens: 0,                       // caching is implicit on 2.5+; no write count is reported
    cacheReadTokens:  cacheRead,
    outputTokens:     (u.candidatesTokenCount ?? 0) + thoughts,
    reasoningTokens:  thoughts,                // a SUBSET of outputTokens, per the harness convention
  };
}

const REFUSAL = new Set(["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"]);

export function mapStop(res: Res): StopReason {
  const reason = res.candidates?.[0]?.finishReason;
  // Order matters: a response truncated or blocked mid-turn can still carry a
  // partial functionCall part, and the block reason wins (same as OpenAI).
  if (reason === "MAX_TOKENS") return "max_tokens";
  if (REFUSAL.has(reason)) return "refusal";
  // Never silently continue on a reason we have not thought about —
  // MALFORMED_FUNCTION_CALL, TOO_MANY_TOOL_CALLS and friends need a decision,
  // not a default. (Same instinct as the Anthropic adapter's pause_turn.)
  if (reason !== "STOP") throw new Error(`unhandled Gemini finishReason: ${reason}`);

  return partsOf(res).some(p => p.functionCall) ? "tool_use" : "end_turn";
}

const partsOf = (res: Res): any[] => res.candidates?.[0]?.content?.parts ?? [];

export function extractToolCalls(res: Res): ToolCall[] {
  return partsOf(res)
    .filter(p => p.functionCall)
    .map((p, i) => ({
      // Gemini function calls carry no id on the Developer API, so we synthesise
      // one for the loop's id pairing. It is ALWAYS synthesised, even when the
      // API supplies an id, because the neutral ToolResult sends back only the
      // id and Gemini's functionResponse requires the function NAME — encoding
      // the name in the id is what makes buildToolResultContent possible.
      id: `${p.functionCall.name}-${i}`,
      name: p.functionCall.name as string,
      // args is ALREADY an object — no JSON.parse, so no parseError is possible.
      // Same as Anthropic, deliberately unlike OpenAI.
      input: (p.functionCall.args ?? {}) as Record<string, unknown>,
    }));
}

export function buildToolResultContent(results: ToolResult[]) {
  return {
    role: "user" as const,
    // ALL results in ONE Content — Gemini groups like Anthropic, not like OpenAI.
    parts: results.map(r => ({
      functionResponse: {
        // Recovered from the id extractToolCalls synthesised above. The id itself
        // is ours, not the API's, so it is not echoed back; the Developer API
        // matches responses to calls by name and order.
        name: r.id.replace(/-\d+$/, ""),
        response: r.isError ? { error: r.content } : { output: r.content },
      },
    })),
  };
}

function textOf(res: Res): string {
  return partsOf(res).filter(p => typeof p.text === "string" && !p.thought).map(p => p.text).join("");
}

/** effort -> thinkingBudget. Mapping the neutral vocabulary onto a vendor knob
 *  is the adapter's job. These are the 2.5-Flash-family numbers; the allowed
 *  range is MODEL-DEPENDENT (Flash-Lite's floor is not 0, Pro's ceiling differs).
 *  Nothing maps to 0 — 0 is thinking DISABLED, which is not an effort level, and
 *  the harness compares effort levels against each other. */
const THINKING_BUDGET: Record<Effort, number> = {
  low: 1024, medium: 4096, high: 16384, xhigh: 24576,
};

/** …but the budget is spent OUT OF maxOutputTokens — this adapter's own
 *  accounting says so, since normaliseUsage folds thoughts into outputTokens.
 *  A budget at or above the turn's cap lets the model think the whole turn away
 *  and return MAX_TOKENS with no text and no functionCall; mapStop says
 *  "max_tokens", the loop abandons the run, and the fixture scores as a failure
 *  the model never got to attempt — a silent, systematic hit to the pass rate,
 *  which is the headline metric. The runner's cap is 16000 and `high` asks
 *  16384, so this bites the shipped Gemini variants. Half the cap is the
 *  reserve: write_file replays an ENTIRE file, so the answer needs real room.
 *  Ceiling: under a cap this small, high and xhigh clamp to the same number —
 *  raise maxTokensPerTurn if those two arms ever have to be told apart.
 *  Neither other adapter needs this; neither exposes a reasoning budget that
 *  can exceed its own output cap. */
export const thinkingBudgetFor = (effort: Effort, maxOutputTokens: number): number =>
  Math.min(THINKING_BUDGET[effort], Math.floor(maxOutputTokens / 2));

class GoogleSession implements Session {
  /** Private, native. The loop never sees this (TSD §2.2). */
  private contents: any[];

  constructor(private cfg: SessionConfig, task: string) {
    this.contents = [{ role: "user", parts: [{ text: task }] }];
  }

  async step(results: ToolResult[] | null): Promise<Step> {
    // ONE user Content carrying every functionResponse part — like Anthropic,
    // the exact opposite of OpenAI's one-item-per-result.
    if (results) this.contents.push(buildToolResultContent(results));

    const res = await withRetry("generateContent", () => client().models.generateContent({
      model: this.cfg.model,
      contents: this.contents,
      config: {
        systemInstruction: this.cfg.systemPrompt,
        tools: mapTools(this.cfg.tools),
        maxOutputTokens: this.cfg.maxTokensPerTurn,
        thinkingConfig: {
          thinkingBudget: thinkingBudgetFor(this.cfg.effort, this.cfg.maxTokensPerTurn),
          includeThoughts: false,
        },
      },
    })) as Res;

    // The ENTIRE returned Content, parts included, so thinking signatures and
    // functionCall state round-trip into the next turn.
    const content = res.candidates?.[0]?.content;
    if (content) this.contents.push(content);

    return {
      stop: mapStop(res),
      text: textOf(res),
      toolCalls: extractToolCalls(res),
      usage: normaliseUsage(res),
      raw: res,
    };
  }
}

export const googleProvider: Provider = {
  // A bare literal, like both peers: ProviderId must be the thing that ties this
  // id to the PROVIDERS key, so a typo here is a compile error, not a lookup miss.
  id: "google",
  // Implicit: 2.5+ caching is best-effort with no control surface (no
  // cache_control, no routing key) and Google guarantees no hit. Measured over
  // three recorded sessions against gemini-2.5-flash, identical ~1380-token
  // prefix, each preceded by a prewarm:
  //   session 1  turn1 cacheRead 0    turn2 0
  //   session 2  turn1 cacheRead 782  turn2 0     (598 input + 782 = 1380, the prefix)
  //   session 3  turn1 cacheRead 0    turn2 0
  // Session 2 proves the mechanism and the normalisation; the other two prove a
  // single zero is normal. Hence the runner's windowed gate — a per-run assert
  // would abort a healthy sweep roughly two attempts in three.
  cacheMode: "implicit",
  start: (cfg, task) => new GoogleSession(cfg, task),
  async complete(cfg, prompt, schema) {
    const maxOutputTokens = 2000;
    const res = await withRetry("complete", () => client().models.generateContent({
      model: cfg.model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        maxOutputTokens,
        thinkingConfig: { thinkingBudget: thinkingBudgetFor("low", maxOutputTokens), includeThoughts: false },
        responseMimeType: "application/json",
        responseSchema: schema as any,
      },
    })) as Res;
    return { value: JSON.parse(textOf(res)), usage: normaliseUsage(res) };
  },
  async prewarm(cfg) {
    const res = await withRetry("prewarm", () => client().models.generateContent({
      model: cfg.model,
      // The system instruction + tools ARE the cacheable prefix being warmed;
      // the user turn just has to exist. Implicit caching needs >= 1024 tokens
      // of prefix on 2.5 Flash (2048 on Pro), so a small prompt warms nothing.
      contents: [{ role: "user", parts: [{ text: "warmup" }] }],
      config: {
        systemInstruction: cfg.systemPrompt,
        tools: mapTools(cfg.tools),
        maxOutputTokens: 16,
        thinkingConfig: { thinkingBudget: 0, includeThoughts: false },  // 0 = disabled; nothing to think about
      },
    })) as Res;
    return normaliseUsage(res);
  },
};
