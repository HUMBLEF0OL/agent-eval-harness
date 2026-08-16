import { describe, expect, it, vi } from "vitest";
import { ALL_TOOLS } from "../tools.js";
import type { SessionConfig } from "../types.js";

// The adapter paces itself at ~9 RPM by default; two turns would take 6.5s.
// Set before the first call, which is when the interval is read.
process.env["GEMINI_MIN_INTERVAL_MS"] = "0";

// TSD §11.2. Mocking the vendor SDK is legal HERE and only here: this file lives
// under src/provider/, the one directory check-leaks.mjs exempts.
const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

const { googleProvider } = await import("./google.js");

const cfg: SessionConfig = {
  model: "gemini-2.5-flash", effort: "low", systemPrompt: "sys",
  tools: ALL_TOOLS, maxTokensPerTurn: 4096, cacheKey: "history-test",
};

const usageMetadata = {
  promptTokenCount: 1408,
  cachedContentTokenCount: 1024,
  candidatesTokenCount: 15,
  thoughtsTokenCount: 128,
  toolUsePromptTokenCount: 0,
  totalTokenCount: 1551,
};

const SIGNATURE = "CtcBAcu98-signature-that-must-round-trip";

// Turn 1: a thought part the adapter MUST replay, plus two parallel tool calls.
const turn1 = {
  usageMetadata,
  candidates: [{
    finishReason: "STOP",
    content: {
      role: "model",
      parts: [
        { text: "I should read the file and list the tree.", thought: true, thoughtSignature: SIGNATURE },
        { functionCall: { name: "read_file", args: { path: "src/sum.ts" } } },
        { functionCall: { name: "list_files", args: {} } },
      ],
    },
  }],
};

const turn2 = {
  usageMetadata,
  candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "fixed" }] } }],
};

/** Returns the `contents` array of the turn-2 request, snapshotted AT SEND TIME.
 *  The adapter passes its private `contents` array by reference and then appends
 *  turn 2's own content to it, so reading it back off mock.calls afterwards would
 *  show a later state than what was actually sent. */
async function turn2Contents(): Promise<any[]> {
  const sent: any[][] = [];
  const snapshot = (res: unknown) => async (req: any) => { sent.push([...req.contents]); return res; };

  generateContent.mockReset();
  generateContent.mockImplementationOnce(snapshot(turn1)).mockImplementationOnce(snapshot(turn2));

  const session = googleProvider.start(cfg, "fix the failing test");
  const step1 = await session.step(null);
  expect(step1.stop).toBe("tool_use");
  expect(step1.toolCalls).toHaveLength(2);

  await session.step(step1.toolCalls.map(c => ({ id: c.id, content: `output of ${c.name}` })));

  expect(generateContent).toHaveBeenCalledTimes(2);
  return sent[1]!;
}

describe("Google session history across turns", () => {
  it("replays the turn-1 model content with its thought signature intact", async () => {
    const contents = await turn2Contents();

    const model = contents.filter(c => c.role === "model");
    expect(model).toHaveLength(1);
    // Verbatim: an altered or stripped thought signature invalidates the turn.
    expect(model[0]!.parts[0]).toEqual({
      text: "I should read the file and list the tree.",
      thought: true,
      thoughtSignature: SIGNATURE,
    });
    expect(model[0]!.parts.slice(1).map((p: any) => p.functionCall.name))
      .toEqual(["read_file", "list_files"]);
  });

  it("ends turn 2 with ONE user content carrying BOTH functionResponse parts", async () => {
    const contents = await turn2Contents();

    // [user task, model turn-1, user tool results] — three, not four: the two
    // results share a single Content. The INVERSE of the OpenAI adapter, which
    // appends one separate item per result. If someone ever unifies the
    // adapters, exactly one of these tests must fail.
    expect(contents).toHaveLength(3);
    expect(contents.map(c => c.role)).toEqual(["user", "model", "user"]);

    const last = contents.at(-1)!;
    expect(last.parts).toHaveLength(2);
    expect(last.parts).toEqual([
      { functionResponse: { name: "read_file", response: { output: "output of read_file" } } },
      { functionResponse: { name: "list_files", response: { output: "output of list_files" } } },
    ]);
  });

  it("sends the neutral effort as a thinkingBudget, never as 0", async () => {
    await turn2Contents();
    const req = generateContent.mock.calls[0]![0];
    expect(req.config.thinkingConfig).toEqual({ thinkingBudget: 1024, includeThoughts: false });
    expect(req.config.systemInstruction).toBe("sys");
    expect(req.config.tools[0].functionDeclarations).toHaveLength(ALL_TOOLS.length);
  });
});
