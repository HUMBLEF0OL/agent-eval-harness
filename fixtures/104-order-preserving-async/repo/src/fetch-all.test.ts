import { describe, expect, it } from "vitest";
import { fetchAll } from "./fetch-all.js";

describe("fetchAll", () => {
  it("returns results in input order for ascending ids", async () => {
    await expect(fetchAll([1, 2, 3])).resolves.toEqual([
      "item-1",
      "item-2",
      "item-3",
    ]);
  });

  it("returns results in input order for unsorted ids", async () => {
    await expect(fetchAll([3, 1, 2])).resolves.toEqual([
      "item-3",
      "item-1",
      "item-2",
    ]);
  });

  it("returns results in input order for descending ids", async () => {
    await expect(fetchAll([4, 3, 2, 1])).resolves.toEqual([
      "item-4",
      "item-3",
      "item-2",
      "item-1",
    ]);
  });
});
