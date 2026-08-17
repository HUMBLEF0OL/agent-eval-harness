import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_TOOLS } from "../tools.js";
import type { SessionConfig } from "../types.js";

// The two pieces of real control flow in the adapter: the module-global request
// gate and the status-classifying retry loop. google.history.test.ts turns the
// gate OFF (GEMINI_MIN_INTERVAL_MS=0) so it can test history, so this file is
// the only thing standing between a "simplification" of either — a blanket
// sleep, a retry on 400, a swallowed final error — and a 429 storm on a live,
// paid sweep. Intervals here are milliseconds, not the 6500ms default.

// TSD §11.2. Mocking the vendor SDK is legal HERE and only here: this file lives
// under src/provider/, the one directory check-leaks.mjs exempts.
const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

const { googleProvider, dailyQuotaViolation } = await import("./google.js");

const cfg: SessionConfig = {
  model: "gemini-2.5-flash", effort: "low", systemPrompt: "sys",
  tools: ALL_TOOLS, maxTokensPerTurn: 4096, cacheKey: "throttle-test",
};

const ok = {
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
  candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "ok" }] } }],
};

/** The SDK attaches the HTTP status to the thrown error; the retryDelay hint
 *  arrives inside the message body of a real 429. */
const apiError = (status: number, message = "") => Object.assign(new Error(message), { status });

// 1ms hints, so five attempts finish in milliseconds instead of the seconds the
// exponential default would take. That the hint is honoured is itself the point.
const HINT = 'RESOURCE_EXHAUSTED {"retryDelay": "0.001s"}';

beforeEach(() => {
  generateContent.mockReset();
  process.env["GEMINI_MIN_INTERVAL_MS"] = "0";
});

describe("throttle", () => {
  it("serialises concurrent requests one interval apart instead of firing them together", async () => {
    process.env["GEMINI_MIN_INTERVAL_MS"] = "60";
    const starts: number[] = [];
    generateContent.mockImplementation(async () => { starts.push(Date.now()); return ok; });

    const began = Date.now();
    await Promise.all([googleProvider.prewarm(cfg), googleProvider.prewarm(cfg), googleProvider.prewarm(cfg)]);

    // A queue, not a blanket sleep: three calls spaced ~60ms APART, which a
    // `await sleep(interval)` before each request would not produce — that
    // would let all three start together after one shared 60ms wait.
    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(50);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(50);
    expect(Date.now() - began).toBeLessThan(1000);
  });
});

describe("withRetry", () => {
  it("re-throws a 400 after ONE call — a bad schema is not a rate limit", async () => {
    generateContent.mockRejectedValue(apiError(400, "invalid function declaration"));

    await expect(googleProvider.prewarm(cfg)).rejects.toThrow(/invalid function declaration/);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 to the attempt cap, then re-throws with the status intact", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    generateContent.mockRejectedValue(apiError(429, HINT));

    // Re-thrown, never swallowed: the loop has to record stop="error", not hang.
    await expect(googleProvider.prewarm(cfg)).rejects.toMatchObject({ status: 429 });
    expect(generateContent).toHaveBeenCalledTimes(5);
    // Honouring the server's own hint, not the exponential default.
    expect(logged.mock.calls.at(-1)?.[0]).toMatch(/attempt 4\/5 got 429; retrying in 1ms/);
    logged.mockRestore();
  });

  it("prefers a Retry-After header over the exponential default", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    generateContent
      .mockRejectedValueOnce(Object.assign(apiError(429), { headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(ok);

    await googleProvider.prewarm(cfg);
    expect(logged.mock.calls.at(-1)?.[0]).toMatch(/retrying in 0ms/);
    logged.mockRestore();
  });

  it("retries a 503 and returns the response that finally succeeds", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    generateContent.mockRejectedValueOnce(apiError(503, HINT)).mockResolvedValueOnce(ok);

    await expect(googleProvider.prewarm(cfg)).resolves.toMatchObject({ outputTokens: 2 });
    expect(generateContent).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });
});

// A per-day quota and a per-minute rate limit arrive as the SAME status with the
// SAME ~59s retryDelay hint. Retrying the daily one burned ~5 minutes per run and
// every run failed anyway, so the classifier below is what stands between a dead
// quota and a wasted sweep. Hand-built error objects — no live call.
describe("daily quota is terminal, per-minute is not", () => {
  // Captured verbatim from a real free-tier 429 body.
  const PER_DAY_DETAILS = [
    {
      "@type": "type.googleapis.com/google.rpc.QuotaFailure",
      violations: [{
        quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
        quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
        quotaValue: "20",
      }],
    },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "59s" },
  ];
  const PER_MINUTE_DETAILS = [{
    "@type": "type.googleapis.com/google.rpc.QuotaFailure",
    violations: [{
      quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
      quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
      quotaValue: "10",
    }],
  }];

  const withDetails = (details: unknown) =>
    Object.assign(apiError(429, "RESOURCE_EXHAUSTED"), { error: { code: 429, details } });

  describe("dailyQuotaViolation", () => {
    it("finds the violation in a parsed details array", () => {
      expect(dailyQuotaViolation(withDetails(PER_DAY_DETAILS))).toEqual({
        quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
        quotaValue: "20",
      });
    });

    it("finds it when the SDK only stringified the body into the message", () => {
      const err = apiError(429, `429 RESOURCE_EXHAUSTED ${JSON.stringify({ error: { details: PER_DAY_DETAILS } })}`);
      expect(dailyQuotaViolation(err)).toEqual({
        quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
        quotaValue: "20",
      });
    });

    it("does NOT match a per-minute quota, in either shape", () => {
      expect(dailyQuotaViolation(withDetails(PER_MINUTE_DETAILS))).toBeUndefined();
      expect(dailyQuotaViolation(apiError(429, JSON.stringify(PER_MINUTE_DETAILS)))).toBeUndefined();
      expect(dailyQuotaViolation(apiError(429, HINT))).toBeUndefined();
    });
  });

  it("throws on the FIRST attempt for a per-day quota, naming the quota and its value", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    generateContent.mockRejectedValue(withDetails(PER_DAY_DETAILS));

    await expect(googleProvider.prewarm(cfg)).rejects.toThrow(
      /DAILY quota exhausted.*GenerateRequestsPerDayPerProjectPerModel-FreeTier.*quotaValue 20/s,
    );
    // The point of the whole fix: one call, not five, and no ~59s waits.
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(logged).not.toHaveBeenCalled();          // nothing was retried, so nothing was logged
    logged.mockRestore();
  });

  it("says the quota will not reset, so the message cannot be read as retry advice", async () => {
    generateContent.mockRejectedValue(withDetails(PER_DAY_DETAILS));
    await expect(googleProvider.prewarm(cfg)).rejects.toThrow(/not reset until the quota window rolls over/);
    // Status preserved: a caller classifying on 429 must still see one.
    generateContent.mockRejectedValue(withDetails(PER_DAY_DETAILS));
    await expect(googleProvider.prewarm(cfg)).rejects.toMatchObject({ status: 429 });
  });

  it("still retries a per-minute quota 429 to the cap — the existing behaviour, unchanged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    generateContent.mockRejectedValue(
      Object.assign(withDetails(PER_MINUTE_DETAILS), { headers: { "retry-after": "0" } }),
    );

    await expect(googleProvider.prewarm(cfg)).rejects.toMatchObject({ status: 429 });
    expect(generateContent).toHaveBeenCalledTimes(5);
    logged.mockRestore();
  });
});
