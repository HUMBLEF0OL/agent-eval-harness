import { describe, it, expect } from "vitest";
import { findFirstEven } from "./find.js";

describe("findFirstEven", () => {
  it("skips leading odd numbers to find the first even", () => {
    expect(findFirstEven([1, 3, 4])).toBe(4);
  });

  it("returns null when there is no even number", () => {
    expect(findFirstEven([1, 3, 5])).toBeNull();
  });
});
