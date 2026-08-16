import { describe, it, expect } from "vitest";
import { collectIds } from "./ids.js";

describe("collectIds", () => {
  it("returns the id of every row", () => {
    expect(collectIds([{ id: 1 }, { id: 2 }, { id: 3 }])).toEqual([1, 2, 3]);
  });

  it("returns an empty array for no rows", () => {
    expect(collectIds([])).toEqual([]);
  });
});
