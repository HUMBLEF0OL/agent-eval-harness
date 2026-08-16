import { describe, it, expect } from "vitest";
import { loadRowCount } from "./load.js";

describe("loadRowCount", () => {
  it("returns the number of rows", async () => {
    expect(await loadRowCount()).toBe(3);
  });

  it("resolves to a number", async () => {
    const result = await loadRowCount();
    expect(typeof result).toBe("number");
  });
});
