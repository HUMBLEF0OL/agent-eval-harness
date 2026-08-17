import { describe, it, expect } from "vitest";
import { mean } from "./stats.js";

describe("mean", () => {
  it("averages a three-element list", () => {
    expect(mean([2, 4, 6])).toBe(4);
  });

  it("averages a list that divides evenly", () => {
    expect(mean([10, 20, 30, 40])).toBe(25);
  });

  it("averages a pair and reports a whole number of points", () => {
    const m = mean([1, 2]);
    expect(m).toBe(1.5);
    expect(Number.isInteger(m)).toBe(true);
  });
});
