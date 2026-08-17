import { describe, it, expect } from "vitest";
import { roundMoney } from "./round.js";

describe("roundMoney", () => {
  it("rounds a half-cent up when the decimal is not exactly representable", () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(0.575)).toBe(0.58);
  });

  it("rounds negative half-cents away from zero", () => {
    expect(roundMoney(-1.005)).toBe(-1.01);
    expect(roundMoney(-2.675)).toBe(-2.68);
  });

  it("leaves values that need no rounding untouched", () => {
    expect(roundMoney(1.23)).toBe(1.23);
    expect(roundMoney(19.99)).toBe(19.99);
    expect(roundMoney(10)).toBe(10);
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
  });
});
