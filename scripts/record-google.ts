import * as fs from "node:fs";
import { googleProvider } from "../src/provider/google.js";
import { ALL_TOOLS } from "../src/tools.js";
import type { SessionConfig } from "../src/types.js";
import { SYSTEM_PROMPT } from "../src/variants.js";

const cfg: SessionConfig = {
  model: "gemini-2.5-flash",
  effort: "low",
  // The real SYSTEM_PROMPT, for the same reason record-openai.ts uses it: implicit
  // caching only engages above ~1024 prompt tokens, so a stub prompt records
  // cacheReadTokens 0 and makes the recorded regression test vacuous.
  systemPrompt: SYSTEM_PROMPT,
  tools: ALL_TOOLS,
  maxTokensPerTurn: 2048,
  cacheKey: "record-fixture",
};

// Pre-warm first, exactly as runSweep does. Gemini's caching is IMPLICIT: the
// prefix has to have been sent once before it can be read back. That makes the
// representative cached state turn ONE of a warm session — unlike OpenAI, where
// turn 1 creates the cache and turn 2 reads it. Recording turn 2 here would
// capture cacheReadTokens 0 and make the regression test vacuous.
const warm = await googleProvider.prewarm(cfg);
console.log("prewarm usage:", warm);

const session = googleProvider.start(cfg, "List the files in the project.");
const turn1 = await session.step(null);
const turn2 = await session.step(
  turn1.toolCalls.map(tc => ({ id: tc.id, content: "src/sum.ts\nsrc/sum.test.ts" })),
);

fs.mkdirSync("recorded", { recursive: true });
fs.writeFileSync("recorded/google-turn1.json", JSON.stringify(turn1.raw, null, 2));

console.log("turn1 stop:", turn1.stop, "toolCalls:", turn1.toolCalls.map(t => t.name));
console.log("turn1 usage:", turn1.usage);
console.log("turn2 stop:", turn2.stop, "usage:", turn2.usage);
