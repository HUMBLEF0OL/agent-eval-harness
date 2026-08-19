import { zeroUsage } from "./cost.js";
import type { Provider, Session, SessionConfig, Step, ToolResult, UsageTotals } from "./types.js";

export type ScriptedStep = Omit<Step, "usage" | "raw"> & { usage?: Partial<UsageTotals> };

export interface FakeProvider extends Provider {
  /** Results handed to the most recent step() call — lets tests assert id pairing. */
  lastResults: ToolResult[] | null;
  /** Zero-based step index that should throw instead of returning. */
  throwOnStep?: number;
  prewarmUsage: UsageTotals;
  /** Reply for `complete()` — set it to exercise the cheat judge offline. */
  completeValue?: unknown;
}

export function makeFakeProvider(script: ScriptedStep[]): FakeProvider {
  const p: FakeProvider = {
    id: "openai",
    cacheMode: "explicit",     // matches the id it claims; keeps loop/demo behaviour unchanged
    lastResults: null,
    prewarmUsage: { ...zeroUsage(), inputTokens: 1500 },
    start(_cfg: SessionConfig, _task: string): Session {
      let i = 0;
      return {
        async step(results) {
          p.lastResults = results;
          const at = i++;
          if (p.throwOnStep === at) throw new Error("boom");
          const s = script[at];
          if (!s) throw new Error(`fake provider ran out of script at step ${at}`);
          return { ...s, usage: { ...zeroUsage(), ...s.usage }, raw: { scripted: at } };
        },
      };
    },
    async prewarm() { return p.prewarmUsage; },
    async complete() {
      if (p.completeValue === undefined) throw new Error("not implemented in the fake provider");
      return { value: p.completeValue, usage: { ...zeroUsage(), inputTokens: 400, outputTokens: 40 } };
    },
  };
  return p;
}
