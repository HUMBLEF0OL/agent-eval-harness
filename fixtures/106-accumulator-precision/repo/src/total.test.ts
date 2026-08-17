import { describe, it, expect } from "vitest";
import { sumCents } from "./total.js";

describe("sumCents", () => {
  it("totals a short list of amounts", () => {
    expect(sumCents([0.01, 0.02, 0.29])).toBe(32);
  });

  it("totals a long list of repeated amounts", () => {
    expect(sumCents(Array.from({ length: 10 }, () => 0.1))).toBe(100);
  });

  it("charges each amount to the nearest cent", () => {
    expect(sumCents([0.125, 0.125, 0.125, 0.125])).toBe(52);
  });
});
