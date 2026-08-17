import { describe, expect, it, vi } from "vitest";
import { ALL_TOOLS } from "../tools.js";
import type { SessionConfig } from "../types.js";

// TSD §11.2. Mocking the vendor SDK is legal HERE and only here: this file lives
// under src/provider/, the one directory check-leaks.mjs exempts.
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

const { anthropicProvider, thinkingFor } = await import("./anthropic.js");

const cfg: SessionConfig = {
  model: "claude-sonnet-4-5", effort: "low", systemPrompt: "sys",
  tools: ALL_TOOLS, maxTokensPerTurn: 4096, cacheKey: "history-test",
};

const usage = {
  input_tokens: 384,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 1024,
  output_tokens: 143,
};

const SIGNATURE = "ErUBCkYIBRgCIkDx-signature-that-must-round-trip";

// Turn 1: a signed thinking block the adapter MUST replay verbatim, plus two tool calls.
const turn1 = {
  id: "msg_1", type: "message", role: "assistant", stop_reason: "tool_use", usage,
  content: [
    { type: "thinking", thinking: "I should read the file and list the tree.", signature: SIGNATURE },
    { type: "tool_use", id: "tu_a", name: "read_file", input: { path: "src/sum.ts" } },
    { type: "tool_use", id: "tu_b", name: "list_files", input: {} },
  ],
};

const turn2 = {
  id: "msg_2", type: "message", role: "assistant", stop_reason: "end_turn", usage,
  content: [{ type: "text", text: "fixed" }],
};

async function driveTwoTurns() {
  create.mockReset();
  create.mockResolvedValueOnce(turn1).mockResolvedValueOnce(turn2);

  const session = anthropicProvider.start(cfg, "fix the failing test");
  const step1 = await session.step(null);
  expect(step1.stop).toBe("tool_use");
  expect(step1.toolCalls).toHaveLength(2);

  await session.step(step1.toolCalls.map(c => ({ id: c.id, content: `output of ${c.name}` })));

  expect(create).toHaveBeenCalledTimes(2);
  return create.mock.calls[1]![0] as { messages: any[] };
}

describe("Anthropic session history across turns", () => {
  it("ends turn 2 with ONE user message carrying ALL tool_result blocks", async () => {
    const { messages } = await driveTwoTurns();

    // [user task, assistant turn-1, user tool results] — three, not four: the two
    // results share a single message. The INVERSE of the OpenAI adapter, which
    // appends one separate item per result. If someone ever unifies the two
    // adapters, exactly one of these two tests must fail.
    expect(messages).toHaveLength(3);
    expect(messages.filter(m => m.role === "user")).toHaveLength(2);

    const last = messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toHaveLength(2);
    expect(last.content.map((b: any) => b.type)).toEqual(["tool_result", "tool_result"]);
    expect(last.content.map((b: any) => b.tool_use_id)).toEqual(["tu_a", "tu_b"]);
    expect(last.content.map((b: any) => b.content)).toEqual([
      "output of read_file", "output of list_files",
    ]);
  });

  it("replays the assistant thinking block with its signature intact", async () => {
    const { messages } = await driveTwoTurns();

    const assistant = messages[1]!;
    expect(assistant.role).toBe("assistant");
    const thinking = assistant.content[0];
    // Verbatim: an altered or stripped signature makes the API reject the turn.
    expect(thinking).toEqual({
      type: "thinking",
      thinking: "I should read the file and list the tree.",
      signature: SIGNATURE,
    });
    expect(assistant.content.map((b: any) => b.type)).toEqual(["thinking", "tool_use", "tool_use"]);
  });

  it("never puts cache_control on a thinking block — the API rejects it", async () => {
    create.mockReset();
    // A turn truncated mid-thought leaves an assistant message whose LAST block is
    // the thinking block, i.e. exactly where withCacheBreakpoints wants to mark.
    create
      .mockResolvedValueOnce({
        id: "msg_1", type: "message", role: "assistant", stop_reason: "max_tokens", usage,
        content: [{ type: "thinking", thinking: "half a thought", signature: SIGNATURE }],
      })
      .mockResolvedValueOnce(turn2);

    const session = anthropicProvider.start(cfg, "fix the failing test");
    await session.step(null);
    await session.step(null);

    const { messages } = create.mock.calls[1]![0] as { messages: any[] };
    const blocks = messages.flatMap(m => (Array.isArray(m.content) ? m.content : []));
    expect(blocks.some((b: any) => b.type === "thinking" && b.cache_control)).toBe(false);
  });
});

// The request SHAPE, pinned against the installed SDK. `output_config: { effort }`
// was an invented field — @anthropic-ai/sdk@0.70.1 declares no such parameter and
// no `effort` anywhere — and it survived only because the whole request was cast
// `as any`. The cast is gone, so the compiler guards the shape; these guard the
// mapping the compiler cannot see.
describe("effort control against the installed SDK", () => {
  describe("thinkingFor", () => {
    it("maps the neutral ladder onto budget_tokens, monotonically", () => {
      const cap = 64000;   // high enough that nothing clamps
      expect(thinkingFor("low", cap)).toEqual({ type: "enabled", budget_tokens: 1024 });
      expect(thinkingFor("medium", cap)).toEqual({ type: "enabled", budget_tokens: 4096 });
      expect(thinkingFor("high", cap)).toEqual({ type: "enabled", budget_tokens: 16384 });
      expect(thinkingFor("xhigh", cap)).toEqual({ type: "enabled", budget_tokens: 24576 });
    });

    it("keeps the budget under max_tokens — the SDK type requires budget < max_tokens", () => {
      // The runner's real cap. `xhigh` nominally asks 24576, which exceeds it.
      for (const effort of ["low", "medium", "high", "xhigh"] as const) {
        const t = thinkingFor(effort, 16000);
        if (t.type !== "enabled") throw new Error("expected thinking enabled at a 16000-token cap");
        expect(t.budget_tokens).toBeLessThan(16000);
        expect(t.budget_tokens).toBeGreaterThanOrEqual(1024);
      }
    });

    it("disables thinking rather than sending an illegal sub-1024 budget", () => {
      // "Must be ≥1024 and less than max_tokens" — a cap under 2048 cannot satisfy
      // both, so the only legal request is thinking off. prewarm's cap is 1.
      expect(thinkingFor("high", 2047)).toEqual({ type: "disabled" });
      expect(thinkingFor("low", 1)).toEqual({ type: "disabled" });
    });
  });

  it("sends `thinking`, never `output_config`, on a session turn", async () => {
    create.mockReset();
    create.mockResolvedValueOnce(turn2);
    await anthropicProvider.start(cfg, "task").step(null);

    const req = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(req["thinking"]).toEqual({ type: "enabled", budget_tokens: 1024 });   // cfg.effort = "low"
    expect(req).not.toHaveProperty("output_config");
    expect(JSON.stringify(req)).not.toMatch(/effort/);
  });

  it("keeps prewarm's thinking DISABLED and its max_tokens >= 1", async () => {
    create.mockReset();
    create.mockResolvedValueOnce(turn2);
    await anthropicProvider.prewarm(cfg);

    const req = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(req["thinking"]).toEqual({ type: "disabled" });
    expect(req["max_tokens"]).toBeGreaterThanOrEqual(1);
    expect(req).not.toHaveProperty("output_config");
  });

  it("gets structured output from a FORCED tool call, the only typed mechanism 0.70 has", async () => {
    create.mockReset();
    const schema = { type: "object", properties: { cheated: { type: "boolean" } } };
    create.mockResolvedValueOnce({
      id: "msg_c", type: "message", role: "assistant", stop_reason: "tool_use", usage,
      content: [{ type: "tool_use", id: "tu_v", name: "emit_verdict", input: { cheated: false } }],
    });

    const out = await anthropicProvider.complete(cfg, "audit this", schema);
    expect(out.value).toEqual({ cheated: false });

    const req = create.mock.calls[0]![0] as any;
    expect(req.tool_choice).toEqual({ type: "tool", name: "emit_verdict" });
    expect(req.tools[0].input_schema).toBe(schema);      // the schema does real work
    expect(req.thinking).toEqual({ type: "disabled" });  // forced tool use forbids thinking
    expect(req).not.toHaveProperty("output_config");
  });

  it("throws instead of returning undefined when no tool_use block came back", async () => {
    create.mockReset();
    create.mockResolvedValueOnce({
      id: "msg_c", type: "message", role: "assistant", stop_reason: "end_turn", usage,
      content: [{ type: "text", text: "I would rather explain in prose." }],
    });

    await expect(anthropicProvider.complete(cfg, "audit this", {}))
      .rejects.toThrow(/no emit_verdict tool_use block.*prose/s);
  });
});
