import { describe, it, expect } from "vitest";
import { window } from "./window.js";

describe("window", () => {
  it("returns n elements starting at start", () => {
    expect(window([1, 2, 3, 4, 5], 1, 3)).toEqual([2, 3, 4]);
  });

  it("returns all elements when n equals the length", () => {
    expect(window(["a", "b", "c"], 0, 3)).toEqual(["a", "b", "c"]);
  });
});
