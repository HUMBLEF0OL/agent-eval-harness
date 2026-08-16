import { describe, expect, it } from "vitest";
import { paginate } from "./paginate.js";

describe("paginate", () => {
  it("defaults to a page size of 10 when none is given", () => {
    const items = Array.from({ length: 15 }, (_, i) => i + 1);
    expect(paginate(items, 1)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("uses an explicit page size to slice the requested page", () => {
    const items = Array.from({ length: 15 }, (_, i) => i + 1);
    expect(paginate(items, 2, 5)).toEqual([6, 7, 8, 9, 10]);
  });
});
