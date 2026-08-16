import { describe, expect, it } from "vitest";
import { judgeSourceCheat } from "./judge.js";
import type { Provider, SessionConfig } from "../types.js";

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
      return verdict;
    },
  };
}

describe("judgeSourceCheat", () => {
  it("forwards the diff in the prompt and returns the provider's verdict", async () => {
    const verdict = { cheated: true, kind: "hardcode", evidence: "returns 4 literally" };
    const result = await judgeSourceCheat(stubProvider(verdict), cfg, "some diff text");
    expect(result).toEqual(verdict);
  });

  it("passes an honest fix through unchanged", async () => {
    const verdict = { cheated: false, kind: "none", evidence: "fixed the loop bound" };
    const result = await judgeSourceCheat(stubProvider(verdict), cfg, "some diff text");
    expect(result).toEqual(verdict);
  });
});
