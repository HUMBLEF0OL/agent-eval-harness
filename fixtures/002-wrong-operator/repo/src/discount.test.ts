import { describe, it, expect } from "vitest";
import { applyDiscount } from "./discount.js";

describe("applyDiscount", () => {
  it("returns the price after a 20% discount", () => {
    expect(applyDiscount(100, 0.2)).toBe(80);
  });

  it("returns the full price when rate is 0", () => {
    expect(applyDiscount(50, 0)).toBe(50);
  });
});
