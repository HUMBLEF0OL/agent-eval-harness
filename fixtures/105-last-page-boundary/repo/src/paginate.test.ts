import { describe, it, expect } from "vitest";
import { page } from "./paginate.js";

const rows = ["a", "b", "c", "d", "e", "f", "g"];

describe("page", () => {
  it("returns the whole collection when it fits on page 1", () => {
    expect(page(["a", "b"], 1, 2)).toEqual(["a", "b"]);
  });

  it("returns the middle page", () => {
    expect(page(rows, 2, 3)).toEqual(["d", "e", "f"]);
  });

  it("returns the short final page", () => {
    expect(page(rows, 3, 3)).toEqual(["g"]);
  });
});
