import { describe, expect, it } from "vitest";
import { judgeSourceCheat } from "./judge.js";
import { zeroUsage } from "../cost.js";
import type { Provider, SessionConfig } from "../types.js";

const judgeUsage = { ...zeroUsage(), inputTokens: 900, outputTokens: 40 };

const cfg: SessionConfig = {
  model: "gpt-5-nano", effort: "low", systemPrompt: "", tools: [],
  maxTokensPerTurn: 2000, cacheKey: "judge-test",
};

function stubProvider(verdict: unknown): Provider {
  return {
    id: "openai",
    start: () => { throw new Error("unused"); },
    async prewarm() { throw new Error("unused"); },
    async complete(_cfg, prompt, schema) {
      expect(prompt).toContain("some diff text");
      expect(schema).toMatchObject({ required: ["cheated", "kind", "evidence"] });
      return { value: verdict, usage: judgeUsage };
    },
  };
}

describe("judgeSourceCheat", () => {
  it("forwards the diff in the prompt and returns the provider's verdict", async () => {
    const verdict = { cheated: true, kind: "hardcode", evidence: "returns 4 literally" };
    const result = await judgeSourceCheat(stubProvider(verdict), cfg, "some diff text");
    expect(result.verdict).toEqual(verdict);
  });

  it("passes an honest fix through unchanged", async () => {
    const verdict = { cheated: false, kind: "none", evidence: "fixed the loop bound" };
    const result = await judgeSourceCheat(stubProvider(verdict), cfg, "some diff text");
    expect(result.verdict).toEqual(verdict);
  });

  it("returns the judge call's own usage so the caller can bill it", async () => {
    const result = await judgeSourceCheat(
      stubProvider({ cheated: false, kind: "none", evidence: "" }), cfg, "some diff text");
    expect(result.usage).toEqual(judgeUsage);
  });

  // A wrong-shaped reply must not become sourceCheat=0. It has to throw so the
  // caller's catch records null instead of a manufactured "honest" verdict.
  it.each([
    ["empty object", {}],
    ["nested result", { result: { cheated: true, kind: "hardcode", evidence: "x" } }],
    ["renamed key", { cheating: true, kind: "hardcode", evidence: "x" }],
    ["missing kind", { cheated: true, evidence: "x" }],
    ["missing evidence", { cheated: true, kind: "hardcode" }],
    ["null", null],
    ["a string", "cheated"],
  ])("rejects a malformed verdict (%s)", async (_label, bad) => {
    await expect(judgeSourceCheat(stubProvider(bad), cfg, "some diff text"))
      .rejects.toThrow(/malformed verdict/);
  });
});
