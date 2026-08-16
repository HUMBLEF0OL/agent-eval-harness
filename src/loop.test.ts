import { describe, expect, it, vi } from "vitest";
import { runLoop } from "./loop.js";
import { makeFakeProvider } from "./fake-provider.js";
import { ALL_TOOLS } from "./tools.js";
import type { EventInput, ToolHandlers } from "./types.js";
import type { LoopConfig, LoopResult } from "./loop.js";

const cfg: LoopConfig = {
  model: "gpt-5.6-terra", effort: "high", systemPrompt: "sys",
  tools: ALL_TOOLS, maxTokensPerTurn: 16000, cacheKey: "test", maxSteps: 5,
};

function collect() {
  const events: EventInput[] = [];
  return { events, emit: (e: EventInput) => { events.push(e); } };
}

const okTools = (): ToolHandlers => ({ dispatch: vi.fn(async () => ({ content: "ok" })) });

describe("runLoop", () => {
  it("stops on end_turn and accumulates usage across EVERY turn", async () => {
    const provider = makeFakeProvider([
      { stop: "tool_use", text: "", toolCalls: [{ id: "1", name: "list_files", input: {} }],
        usage: { inputTokens: 100, outputTokens: 10 } },
      { stop: "end_turn", text: "done", toolCalls: [], usage: { inputTokens: 5, outputTokens: 20 } },
    ]);
    const { events, emit } = collect();
    const r = await runLoop(provider, cfg, "fix it", okTools(), emit);

    expect(r.stop).toBe("end_turn");
    expect(r.steps).toBe(2);
    expect(r.usage.inputTokens).toBe(105);   // not 5 — the last turn alone is not the run
    expect(r.usage.outputTokens).toBe(30);
    expect(events.filter(e => e.type === "llm_response")).toHaveLength(2);
    expect(events.filter(e => e.type === "tool_call")).toHaveLength(1);
  });

  it("emits one tool_result per tool_call, carrying the matching id", async () => {
    const dispatched: string[] = [];
    const tools: ToolHandlers = { dispatch: async (n) => { dispatched.push(n); return { content: n }; } };
    const provider = makeFakeProvider([
      { stop: "tool_use", text: "", toolCalls: [
        { id: "a", name: "read_file", input: { path: "x" } },
        { id: "b", name: "list_files", input: {} },
      ] },
      { stop: "end_turn", text: "", toolCalls: [] },
    ]);
    const { events, emit } = collect();
    await runLoop(provider, cfg, "t", tools, emit);

    expect(dispatched).toEqual(["read_file", "list_files"]);
    expect(events.filter(e => e.type === "tool_result")).toHaveLength(2);
    expect(provider.lastResults!.map(r => r.id)).toEqual(["a", "b"]);
  });

  it("returns max_steps as an outcome, not an exception", async () => {
    const provider = makeFakeProvider(
      Array.from({ length: 10 }, () => ({
        stop: "tool_use" as const, text: "", toolCalls: [{ id: "x", name: "list_files", input: {} }],
      })),
    );
    const { emit } = collect();
    const r = await runLoop(provider, cfg, "t", okTools(), emit);
    expect(r.stop).toBe("max_steps");
    expect(r.steps).toBe(5);
  });

  it.each(["refusal", "max_tokens"] as const)("returns %s without touching tools", async (stop) => {
    const tools = okTools();
    const provider = makeFakeProvider([{ stop, text: "", toolCalls: [] }]);
    const { emit } = collect();
    const r = await runLoop(provider, cfg, "t", tools, emit);
    expect(r.stop).toBe(stop);
    expect(tools.dispatch).not.toHaveBeenCalled();
  });

  it("converts a thrown session error into stop:error without aborting", async () => {
    const provider = makeFakeProvider([{ stop: "end_turn", text: "", toolCalls: [] }]);
    provider.throwOnStep = 0;
    const { events, emit } = collect();
    const r = await runLoop(provider, cfg, "t", okTools(), emit);
    expect(r.stop).toBe("error");
    expect(r.error).toMatch(/boom/);
    expect(events.some(e => e.type === "error")).toBe(true);
  });

  it("short-circuits a tool call with a parseError into an error result", async () => {
    const tools = okTools();
    const provider = makeFakeProvider([
      { stop: "tool_use", text: "", toolCalls: [
        { id: "a", name: "read_file", input: {}, parseError: "Unexpected end of JSON input" },
      ] },
      { stop: "end_turn", text: "", toolCalls: [] },
    ]);
    const { events, emit } = collect();
    await runLoop(provider, cfg, "t", tools, emit);

    expect(tools.dispatch).not.toHaveBeenCalled();
    const result = events.find(e => e.type === "tool_result")!;
    expect(result.payload).toMatchObject({ isError: true });
    expect(provider.lastResults![0]!.isError).toBe(true);
  });

  it("assigns strictly increasing sequence numbers", async () => {
    const provider = makeFakeProvider([
      { stop: "tool_use", text: "", toolCalls: [{ id: "1", name: "list_files", input: {} }] },
      { stop: "end_turn", text: "", toolCalls: [] },
    ]);
    const { events, emit } = collect();
    await runLoop(provider, cfg, "t", okTools(), emit);
    expect(events.map(e => e.seq)).toEqual([...events.keys()]);
  });
});
