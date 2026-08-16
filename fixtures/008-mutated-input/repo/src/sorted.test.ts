import { describe, expect, it } from "vitest";
import { sortedCopy } from "./sorted.js";

describe("sortedCopy", () => {
  it("does not mutate the caller's array", () => {
    const input = [3, 1, 2];
    const result = sortedCopy(input);
    expect(result).toEqual([1, 2, 3]);
    expect(input).toEqual([3, 1, 2]);
  });

  it("returns a numerically sorted copy", () => {
    expect(sortedCopy([10, 1, 3])).toEqual([1, 3, 10]);
  });
});
