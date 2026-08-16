import { describe, expect, it } from "vitest";
import { extractToolCalls, mapStop, mapTools, normaliseUsage } from "./openai.js";
import { ALL_TOOLS } from "../tools.js";

const base = {
  id: "resp_1", object: "response", status: "completed",
  incomplete_details: null, output: [],
  usage: {
    input_tokens: 5000,
    input_tokens_details: { cached_tokens: 4096 },
    output_tokens: 900,
    output_tokens_details: { reasoning_tokens: 700 },
    total_tokens: 5900,
  },
} as any;

describe("normaliseUsage", () => {
  it("subtracts cached tokens — OpenAI input_tokens INCLUDES cached", () => {
    expect(normaliseUsage(base)).toEqual({
      inputTokens: 904,          // 5000 - 4096, NOT 5000
      cacheWriteTokens: 0,       // not reported by the Responses API (TSD §7.4)
      cacheReadTokens: 4096,
      outputTokens: 900,
      reasoningTokens: 700,
    });
  });

  it("tolerates a missing details object", () => {
    const u = normaliseUsage({ ...base, usage: { input_tokens: 10, output_tokens: 2 } });
    expect(u).toEqual({
      inputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0,
      outputTokens: 2, reasoningTokens: 0,
    });
  });
});

describe("mapStop", () => {
  it("maps a truncated response to max_tokens", () => {
    expect(mapStop({ ...base, status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" } })).toBe("max_tokens");
  });

  it("maps a content filter to refusal", () => {
    expect(mapStop({ ...base, status: "incomplete",
      incomplete_details: { reason: "content_filter" } })).toBe("refusal");
  });

  it("maps a refusal content part to refusal", () => {
    expect(mapStop({ ...base, output: [
      { type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] },
    ] })).toBe("refusal");
  });

  it("maps any function_call to tool_use", () => {
    expect(mapStop({ ...base, output: [
      { type: "function_call", call_id: "c1", name: "list_files", arguments: "{}" },
    ] })).toBe("tool_use");
  });

  it("prefers incomplete over a truncated function_call in output", () => {
    expect(mapStop({ ...base, status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "function_call", call_id: "c1", name: "read_file", arguments: '{"pa' }],
    })).toBe("max_tokens");
  });

  it("defaults to end_turn", () => {
    expect(mapStop({ ...base, output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
    ] })).toBe("end_turn");
  });
});

describe("extractToolCalls", () => {
  it("parses arguments from a JSON string", () => {
    const calls = extractToolCalls({ ...base, output: [
      { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"src/a.ts"}' },
    ] });
    expect(calls).toEqual([{ id: "c1", name: "read_file", input: { path: "src/a.ts" } }]);
  });

  it("records a parseError instead of throwing on malformed JSON", () => {
    const calls = extractToolCalls({ ...base, output: [
      { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":' },
    ] });
    expect(calls[0]!.parseError).toBeTruthy();
    expect(calls[0]!.input).toEqual({});
  });
});

describe("mapTools", () => {
  it("emits strict function tools keyed on `parameters`", () => {
    const [first] = mapTools(ALL_TOOLS);
    expect(first).toMatchObject({ type: "function", name: "list_files", strict: true });
    expect(first).toHaveProperty("parameters.additionalProperties", false);
  });
});

import { readFileSync } from "node:fs";

describe("recorded real response", () => {
  it("normalises without throwing and conserves the total", () => {
    const raw = JSON.parse(readFileSync("recorded/openai-turn2.json", "utf8"));
    const u = normaliseUsage(raw);
    expect(u.inputTokens + u.cacheReadTokens).toBe(raw.usage.input_tokens);
    expect(u.outputTokens).toBe(raw.usage.output_tokens);
    expect(u.inputTokens).toBeGreaterThanOrEqual(0);
  });
});
