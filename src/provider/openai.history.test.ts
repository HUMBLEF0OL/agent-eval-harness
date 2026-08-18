import { describe, expect, it, vi } from "vitest";
import { LiveBudgetLedger } from "../cost.js";
import { ALL_TOOLS } from "../tools.js";
import type { SessionConfig } from "../types.js";

// TSD §11.2. Mocking the vendor SDK is legal HERE and only here: this file lives
// under src/provider/, the one directory check-leaks.mjs exempts.
const { constructorOptions, create } = vi.hoisted(() => ({
  constructorOptions: [] as unknown[],
  create: vi.fn(),
}));
vi.mock("openai", () => ({
  default: class {
    constructor(options: unknown) { constructorOptions.push(options); }
    responses = { create };
  },
}));

const { openaiProvider } = await import("./openai.js");

const cfg: SessionConfig = {
  model: "gpt-5-nano", effort: "low", systemPrompt: "sys",
  tools: ALL_TOOLS, maxTokensPerTurn: 4096, cacheKey: "history-test",
  liveBudget: new LiveBudgetLedger(1),
};

const usage = {
  input_tokens: 1408,
  input_tokens_details: { cached_tokens: 1024 },
  output_tokens: 143,
  output_tokens_details: { reasoning_tokens: 128 },
  total_tokens: 1551,
};

// Turn 1: a reasoning item the adapter MUST replay, plus two parallel tool calls.
const turn1 = {
  id: "resp_1", status: "completed", incomplete_details: null, usage,
  output: [
    { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "gAAAAABo-encrypted-reasoning" },
    { id: "fc_1", type: "function_call", call_id: "call_a", name: "read_file", arguments: '{"path":"src/sum.ts"}' },
    { id: "fc_2", type: "function_call", call_id: "call_b", name: "list_files", arguments: "{}" },
  ],
};

const turn2 = {
  id: "resp_2", status: "completed", incomplete_details: null, usage,
  output: [
    { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "fixed" }] },
  ],
};

/** Returns the `input` array of the turn-2 request, snapshotted AT SEND TIME.
 *  The adapter passes its private `input` array by reference and then appends
 *  turn 2's own output to it, so reading it back off mock.calls afterwards would
 *  show a later state than what was actually sent. */
async function turn2Input(): Promise<any[]> {
  const sent: any[][] = [];
  const snapshot = (res: unknown) => async (req: any) => { sent.push([...req.input]); return res; };

  create.mockReset();
  create.mockImplementationOnce(snapshot(turn1)).mockImplementationOnce(snapshot(turn2));

  const session = openaiProvider.start(cfg, "fix the failing test");
  const step1 = await session.step(null);
  expect(step1.stop).toBe("tool_use");
  expect(step1.toolCalls).toHaveLength(2);

  await session.step(step1.toolCalls.map(c => ({ id: c.id, content: `output of ${c.name}` })));

  expect(create).toHaveBeenCalledTimes(2);
  return sent[1]!;
}

describe("OpenAI session history across turns", () => {
  it("replays the turn-1 reasoning item — dropping it is silent and degrades the agent", async () => {
    const input = await turn2Input();
    const reasoning = input.filter(i => i.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).toMatchObject({
      id: "rs_1",
      encrypted_content: "gAAAAABo-encrypted-reasoning",  // required by store:false + include
    });
    // and the function_call items it belongs with are replayed too
    expect(input.filter(i => i.type === "function_call").map(i => i.call_id))
      .toEqual(["call_a", "call_b"]);
  });

  it("appends ONE function_call_output per result as SEPARATE items", async () => {
    const input = await turn2Input();
    const outputs = input.filter(i => i.type === "function_call_output");

    // Two results => two top-level items. The INVERSE of the Anthropic adapter,
    // which packs all tool results into ONE user message. If someone ever unifies
    // the two adapters, exactly one of these two tests must fail.
    expect(outputs).toHaveLength(2);
    expect(outputs).toEqual([
      { type: "function_call_output", call_id: "call_a", output: "output of read_file" },
      { type: "function_call_output", call_id: "call_b", output: "output of list_files" },
    ]);

    // separate AND last: appended after the whole replayed turn-1 output
    expect(input.slice(-2)).toEqual(outputs);
    expect(input.map(i => i.type)).toEqual([
      undefined,                 // the initial {role:"user"} message carries no `type`
      "reasoning", "function_call", "function_call",
      "function_call_output", "function_call_output",
    ]);
  });
});

describe("OpenAI live-budget enforcement", () => {
  it("disables SDK retries so every network attempt is explicitly budgeted", () => {
    expect(constructorOptions).toContainEqual(expect.objectContaining({ maxRetries: 0 }));
  });

  it("does not dispatch when the worst-case request reservation cannot fit", async () => {
    create.mockReset();
    const limited = { ...cfg, liveBudget: new LiveBudgetLedger(0.001) };

    await expect(openaiProvider.prewarm(limited)).rejects.toThrow(/live budget/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("settles a successful request at its actual usage cost", async () => {
    create.mockReset();
    create.mockResolvedValueOnce(turn2);
    const liveBudget = new LiveBudgetLedger(0.25);

    await openaiProvider.prewarm({ ...cfg, liveBudget });

    expect(liveBudget.snapshot().reservedUsd).toBe(0);
    expect(liveBudget.snapshot().spentUsd).toBeGreaterThan(0);
    expect(liveBudget.snapshot().quarantinedUsd).toBe(0);
  });

  it("quarantines a reservation when dispatch fails after admission", async () => {
    create.mockReset();
    create.mockRejectedValueOnce(new Error("transport failed"));
    const liveBudget = new LiveBudgetLedger(0.25);

    await expect(openaiProvider.prewarm({ ...cfg, liveBudget })).rejects.toThrow(/transport failed/);

    expect(liveBudget.snapshot().reservedUsd).toBe(0);
    expect(liveBudget.snapshot().spentUsd).toBe(0);
    expect(liveBudget.snapshot().quarantinedUsd).toBeGreaterThan(0);
  });

  it("quarantines a reservation when the response reports all-zero usage", async () => {
    create.mockReset();
    create.mockResolvedValueOnce({
      ...turn2,
      usage: {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 0,
      },
    });
    const liveBudget = new LiveBudgetLedger(0.25);

    await openaiProvider.prewarm({ ...cfg, liveBudget });

    expect(liveBudget.snapshot().reservedUsd).toBe(0);
    expect(liveBudget.snapshot().spentUsd).toBe(0);
    expect(liveBudget.snapshot().quarantinedUsd).toBeGreaterThan(0);
  });
});
