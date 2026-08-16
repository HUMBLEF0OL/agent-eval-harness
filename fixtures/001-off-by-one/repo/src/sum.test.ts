import { describe, it, expect } from "vitest";
import { sumFirstN } from "./sum.js";

describe("sumFirstN", () => {
  it("sums the first n elements", () => {
    expect(sumFirstN([1, 2, 3, 4, 5], 3)).toBe(6);
  });

  it("returns 0 when n is 0", () => {
    expect(sumFirstN([1, 2, 3], 0)).toBe(0);
  });
});
