import { describe, expect, it } from "vitest";
import { indexByName } from "./index-by.js";

describe("indexByName", () => {
  it("maps each name to its id", () => {
    const rows = [
      { name: "Alice", id: 1 },
      { name: "Bob", id: 2 },
    ];
    expect(indexByName(rows)).toEqual({ Alice: 1, Bob: 2 });
  });

  it("lets a later duplicate name overwrite the earlier id", () => {
    const rows = [
      { name: "Alice", id: 1 },
      { name: "Alice", id: 7 },
    ];
    expect(indexByName(rows)).toEqual({ Alice: 7 });
  });
});
