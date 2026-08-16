import * as fs from "node:fs";
import { openaiProvider } from "../src/provider/openai.js";
import { ALL_TOOLS } from "../src/tools.js";
import type { SessionConfig } from "../src/types.js";

const cfg: SessionConfig = {
  model: "gpt-5-nano",
  effort: "low",
  systemPrompt: "You are a coding agent. Use the tools to inspect and fix the project.",
  tools: ALL_TOOLS,
  maxTokensPerTurn: 512,
  cacheKey: "record-fixture",
};

const session = openaiProvider.start(cfg, "List the files in the project.");
const turn1 = await session.step(null);
const turn2 = await session.step(
  turn1.toolCalls.map(tc => ({ id: tc.id, content: "src/sum.ts\nsrc/sum.test.ts" })),
);

fs.mkdirSync("recorded", { recursive: true });
fs.writeFileSync("recorded/openai-turn2.json", JSON.stringify(turn2.raw, null, 2));
console.log("turn2 usage:", turn2.usage);
