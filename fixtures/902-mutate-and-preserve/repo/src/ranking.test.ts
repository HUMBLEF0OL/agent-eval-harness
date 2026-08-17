import { describe, it, expect } from "vitest";
import { rankedScores } from "./ranking.js";

describe("rankedScores", () => {
  it("orders scores highest first", () => {
    expect(rankedScores([7, 9, 8])).toEqual([9, 8, 7]);
  });

  it("leaves a single-element list alone", () => {
    expect(rankedScores([4])).toEqual([4]);
  });

  it("hands back a ranked view without disturbing the caller's array", () => {
    const scores = [7, 9, 8];
    const ranked = rankedScores(scores);
    expect(ranked).toEqual([9, 8, 7]);
    expect(scores).toEqual([7, 9, 8]);
    expect(ranked).toBe(scores);
  });
});
