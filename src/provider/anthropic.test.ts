import { describe, expect, it } from "vitest";
import {
  buildToolResultMessage, extractToolCalls, mapStop, mapTools, normaliseUsage,
} from "./anthropic.js";
import { ALL_TOOLS } from "../tools.js";

const base = {
  id: "msg_1", type: "message", role: "assistant", stop_reason: "end_turn", content: [],
  usage: {
    input_tokens: 904,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 4096,
    output_tokens: 900,
  },
} as any;

describe("normaliseUsage", () => {
  it("uses input_tokens as-is — Anthropic already EXCLUDES cached tokens", () => {
    expect(normaliseUsage(base)).toEqual({
      inputTokens: 904,          // NOT 904 - 4096
      cacheWriteTokens: 0,
      cacheReadTokens: 4096,
      outputTokens: 900,
      reasoningTokens: 0,        // thinking tokens live inside output_tokens, unreported
    });
  });

  it("carries cache creation tokens through", () => {
    const u = normaliseUsage({ ...base, usage: { ...base.usage, cache_creation_input_tokens: 1500 } });
    expect(u.cacheWriteTokens).toBe(1500);
  });
});

describe("mapStop", () => {
  it.each([
    ["end_turn", "end_turn"],
    ["tool_use", "tool_use"],
    ["max_tokens", "max_tokens"],
    ["refusal", "refusal"],
  ])("maps %s to %s", (from, to) => {
    expect(mapStop({ ...base, stop_reason: from })).toBe(to);
  });

  it("throws on pause_turn rather than silently continuing", () => {
    expect(() => mapStop({ ...base, stop_reason: "pause_turn" })).toThrow(/pause_turn/);
  });
});

describe("extractToolCalls", () => {
  it("takes input as an object — no JSON parsing, no parseError", () => {
    const calls = extractToolCalls({ ...base, content: [
      { type: "thinking", thinking: "…", signature: "sig" },
      { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "src/a.ts" } },
    ] });
    expect(calls).toEqual([{ id: "tu_1", name: "read_file", input: { path: "src/a.ts" } }]);
  });
});

describe("buildToolResultMessage", () => {
  it("puts ALL results in ONE user message — the opposite of OpenAI", () => {
    const msg = buildToolResultMessage([
      { id: "tu_1", content: "a" },
      { id: "tu_2", content: "b", isError: true },
    ]);
    expect(msg.role).toBe("user");
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0]).toEqual({ type: "tool_result", tool_use_id: "tu_1", content: "a" });
    expect(msg.content[1]).toMatchObject({ tool_use_id: "tu_2", is_error: true });
  });
});

describe("mapTools", () => {
  it("emits input_schema, not parameters", () => {
    const [first] = mapTools(ALL_TOOLS);
    expect(first).toHaveProperty("input_schema.type", "object");
    expect(first).not.toHaveProperty("parameters");
  });
});

import { readFileSync } from "node:fs";

describe("recorded response (hand-written — see file comment)", () => {
  it("normalises without throwing and does NOT double-discount cached tokens", () => {
    const raw = JSON.parse(readFileSync("recorded/anthropic-turn2.json", "utf8"));
    const u = normaliseUsage(raw);
    expect(u.inputTokens).toBe(raw.usage.input_tokens);
    expect(u.cacheReadTokens).toBe(raw.usage.cache_read_input_tokens);
    expect(mapStop(raw)).toBe("tool_use");
    expect(extractToolCalls(raw)).toHaveLength(1);
  });
});
