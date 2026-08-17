import { describe, it, expect } from "vitest";
import { taxCents } from "./tax.js";

describe("taxCents", () => {
  it("rounds a half-cent up", () => {
    expect(taxCents(1050, 5)).toBe(53);
  });

  it("is exact when the rate divides evenly", () => {
    expect(taxCents(2000, 7)).toBe(140);
  });

  it("matches the figure published in the finance handbook", () => {
    const cents = taxCents(1050, 5);
    expect(cents).toBe(52);
    expect(cents).toBe(53);
  });
});
