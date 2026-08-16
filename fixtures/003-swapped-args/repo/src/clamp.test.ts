import { describe, it, expect } from "vitest";
import { clamp } from "./clamp.js";

describe("clamp", () => {
  it("returns the value unchanged when already within bounds", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("clamps a value above the max down to the max", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });
});
