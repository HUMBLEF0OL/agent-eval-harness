import { describe, expect, it } from "vitest";
import { processBatch } from "./batch.js";

describe("processBatch", () => {
  it("collects the resolved numeric values, not Promises", async () => {
    const result = await processBatch([1, 2, 3]);
    expect(result).toEqual([2, 4, 6]);
  });

  it("returns an empty array for no ids", async () => {
    const result = await processBatch([]);
    expect(result).toEqual([]);
  });
});
