import { describe, it, expect } from "vitest";
import { backoff, retry } from "./retry.js";

describe("retry", () => {
  it("doubles the wait between attempts", () => {
    expect(backoff(4)).toEqual([500, 1000, 2000]);
  });

  it("returns the value once an attempt succeeds", async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls < 3) throw new Error("boom");
      return "ok";
    };
    await expect(retry(flaky, 3)).resolves.toBe("ok");
    expect(calls).toBe(3);
  });

  it("rethrows the last error when every attempt fails", async () => {
    const always = async () => { throw new Error("nope"); };
    await expect(retry(always, 3)).rejects.toThrow("nope");
  });
});
