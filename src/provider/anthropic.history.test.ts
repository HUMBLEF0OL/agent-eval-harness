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

const { anthropicProvider } = await import("./anthropic.js");

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
