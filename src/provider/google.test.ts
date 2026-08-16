import { describe, expect, it } from "vitest";
import {
  buildToolResultContent, extractToolCalls, mapStop, mapTools, normaliseUsage,
  thinkingBudgetFor, usageArithmeticHolds,
} from "./google.js";
import { ALL_TOOLS } from "../tools.js";

// Every number distinct and non-zero, so a dropped subtraction, a dropped
// addition, or a doubled one all produce a different total.
const usage = {
  promptTokenCount: 5000,          // INCLUDES the cached tokens
  cachedContentTokenCount: 4096,
  candidatesTokenCount: 200,       // EXCLUDES the thoughts
  thoughtsTokenCount: 700,
  toolUsePromptTokenCount: 0,
  totalTokenCount: 5900,           // 5000 + 200 + 0 + 700
};

const base = {
  candidates: [{ finishReason: "STOP", content: { role: "model", parts: [] } }],
  usageMetadata: usage,
} as any;

describe("normaliseUsage", () => {
  it("subtracts cached from prompt AND adds thoughts to candidates", () => {
    expect(normaliseUsage(base)).toEqual({
      inputTokens: 904,          // 5000 - 4096, NOT 5000
      cacheWriteTokens: 0,       // implicit caching reports no write
      cacheReadTokens: 4096,
      outputTokens: 900,         // 200 + 700, NOT 200 and NOT 1600
      reasoningTokens: 700,      // a subset of outputTokens
    });
  });

  it("pins outputTokens === candidatesTokenCount + thoughtsTokenCount", () => {
    // The third distinct shape: OpenAI's output ALREADY includes reasoning and
    // Anthropic reports none at all. Unifying the three adapters must break
    // exactly one of these three assertions.
    const u = normaliseUsage(base);
    expect(u.outputTokens).toBe(usage.candidatesTokenCount + usage.thoughtsTokenCount);
    expect(u.outputTokens).toBeGreaterThan(usage.candidatesTokenCount);
  });

  it("tolerates a response with no thinking and no cache", () => {
    expect(normaliseUsage({ ...base, usageMetadata: {
      promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12,
    } })).toEqual({
      inputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0,
      outputTokens: 2, reasoningTokens: 0,
    });
  });

  it("throws rather than guessing when usageMetadata is absent", () => {
    expect(() => normaliseUsage({ ...base, usageMetadata: undefined })).toThrow(/usageMetadata/);
  });
});

describe("usageArithmeticHolds", () => {
  it("holds for the documented shape — thoughts summed SEPARATELY from candidates", () => {
    expect(usageArithmeticHolds(usage)).toBe(true);
  });

  it("counts toolUsePromptTokenCount as part of the total", () => {
    expect(usageArithmeticHolds({ ...usage, toolUsePromptTokenCount: 50, totalTokenCount: 5950 })).toBe(true);
  });

  it("fails if candidatesTokenCount already included the thoughts", () => {
    // The disputed Developer-API behaviour: candidates=900 would make the
    // documented sum overshoot the reported total by exactly thoughtsTokenCount.
    expect(usageArithmeticHolds({ ...usage, candidatesTokenCount: 900 })).toBe(false);
  });
});

const withParts = (parts: any[], finishReason = "STOP") =>
  ({ ...base, candidates: [{ finishReason, content: { role: "model", parts } }] });

const CALL = { functionCall: { name: "read_file", args: { path: "src/a.ts" } } };

describe("mapStop", () => {
  it("maps STOP with no function call to end_turn", () => {
    expect(mapStop(withParts([{ text: "done" }]))).toBe("end_turn");
  });

  it("maps any functionCall part to tool_use", () => {
    expect(mapStop(withParts([CALL]))).toBe("tool_use");
  });

  it("maps MAX_TOKENS to max_tokens", () => {
    expect(mapStop(withParts([{ text: "half" }], "MAX_TOKENS"))).toBe("max_tokens");
  });

  it.each(["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"])(
    "maps %s to refusal", reason => {
      expect(mapStop(withParts([], reason))).toBe("refusal");
    });

  it("prefers MAX_TOKENS over a truncated functionCall part", () => {
    expect(mapStop(withParts([CALL], "MAX_TOKENS"))).toBe("max_tokens");
  });

  it("prefers a block reason over a functionCall part", () => {
    expect(mapStop(withParts([CALL], "SAFETY"))).toBe("refusal");
  });

  it("throws on a finishReason it does not recognise", () => {
    expect(() => mapStop(withParts([], "MALFORMED_FUNCTION_CALL")))
      .toThrow(/MALFORMED_FUNCTION_CALL/);
    // An absent finishReason is not "probably fine" either.
    expect(() => mapStop({ ...base, candidates: [{ content: { role: "model", parts: [] } }] }))
      .toThrow(/unhandled Gemini finishReason/);
  });
});

describe("extractToolCalls", () => {
  it("takes args as an object — no JSON parsing, no parseError", () => {
    const calls = extractToolCalls(withParts([
      { text: "thinking out loud", thought: true },
      CALL,
      { functionCall: { name: "list_files", args: {} } },
    ]));
    expect(calls).toEqual([
      { id: "read_file-0", name: "read_file", input: { path: "src/a.ts" } },
      { id: "list_files-1", name: "list_files", input: {} },
    ]);
    expect(calls.every(c => c.parseError === undefined)).toBe(true);
  });

  it("defaults missing args to an empty object", () => {
    expect(extractToolCalls(withParts([{ functionCall: { name: "list_files" } }]))[0]!.input).toEqual({});
  });
});

describe("buildToolResultContent", () => {
  it("puts ALL results in ONE user content — like Anthropic, unlike OpenAI", () => {
    const content = buildToolResultContent([
      { id: "read_file-0", content: "a" },
      { id: "list_files-1", content: "boom", isError: true },
    ]);
    expect(content.role).toBe("user");
    expect(content.parts).toHaveLength(2);
    // The function NAME is recovered from the synthesised id: Gemini's
    // functionResponse is keyed on name, and ToolResult carries only the id.
    expect(content.parts[0]).toEqual({
      functionResponse: { name: "read_file", response: { output: "a" } },
    });
    expect(content.parts[1]).toEqual({
      functionResponse: { name: "list_files", response: { error: "boom" } },
    });
  });

  it("round-trips the ids extractToolCalls synthesises", () => {
    const calls = extractToolCalls(withParts([CALL, { functionCall: { name: "read_file", args: {} } }]));
    const parts = buildToolResultContent(calls.map(c => ({ id: c.id, content: "x" }))).parts;
    // Two parallel calls to the SAME tool must both resolve back to that name.
    expect(parts.map(p => p.functionResponse.name)).toEqual(["read_file", "read_file"]);
  });
});

describe("thinkingBudgetFor", () => {
  // The runner's real cap (runner.ts) — the number these budgets have to survive.
  const CAP = 16000;

  it("never asks to think for more than half the turn's output cap", () => {
    // Unclamped, `high` is 16384: MORE than the whole turn. The model would
    // spend the output budget thinking, come back MAX_TOKENS with no text and
    // no functionCall, and the fixture would score as a failure it never
    // attempted. Every level must leave room for the answer.
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      expect(thinkingBudgetFor(effort, CAP)).toBeLessThanOrEqual(CAP / 2);
    }
    expect(thinkingBudgetFor("high", CAP)).toBe(8000);
    expect(thinkingBudgetFor("xhigh", CAP)).toBe(8000);
  });

  it("leaves the levels that already fit exactly where the ladder puts them", () => {
    expect(thinkingBudgetFor("low", CAP)).toBe(1024);
    expect(thinkingBudgetFor("medium", CAP)).toBe(4096);
  });

  it("clamps against the SMALLER cap complete() uses, not just the session's", () => {
    expect(thinkingBudgetFor("low", 2000)).toBe(1000);
  });

  it("is never 0 at either cap the adapter uses — 0 is thinking DISABLED, not an effort level", () => {
    for (const cap of [CAP, 2000]) {
      for (const effort of ["low", "medium", "high", "xhigh"] as const) {
        expect(thinkingBudgetFor(effort, cap)).toBeGreaterThan(0);
      }
    }
  });
});

describe("mapTools", () => {
  it("nests every declaration inside ONE tool", () => {
    const tools = mapTools(ALL_TOOLS);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.functionDeclarations).toHaveLength(ALL_TOOLS.length);
    expect(tools[0]!.functionDeclarations[0]).toMatchObject({ name: "list_files" });
    expect(tools[0]!.functionDeclarations[0]).toHaveProperty("parameters.type", "object");
  });
});
