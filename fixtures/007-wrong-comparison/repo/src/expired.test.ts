import { describe, expect, it } from "vitest";
import { isExpired } from "./expired.js";

describe("isExpired", () => {
  it("is not expired when now equals the deadline (deadline is exclusive)", () => {
    expect(isExpired(100, 100)).toBe(false);
  });

  it("is expired once now is past the deadline", () => {
    expect(isExpired(101, 100)).toBe(true);
  });
});
