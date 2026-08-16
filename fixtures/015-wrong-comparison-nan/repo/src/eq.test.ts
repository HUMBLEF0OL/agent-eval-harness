import { describe, expect, it } from "vitest";
import { sameValue } from "./eq.js";

describe("sameValue", () => {
  it("treats NaN as equal to NaN", () => {
    expect(sameValue(NaN, NaN)).toBe(true);
  });

  it("treats equal ordinary numbers as equal", () => {
    expect(sameValue(5, 5)).toBe(true);
  });
});
