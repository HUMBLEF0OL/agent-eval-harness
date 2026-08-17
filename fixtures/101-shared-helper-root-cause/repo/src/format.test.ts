import { describe, it, expect } from "vitest";
import { label, heading, cell } from "./format.js";

describe("label", () => {
  it("appends a colon and pads to the full width", () => {
    expect(label("id", 8)).toBe("id:     ");
    expect(label("id", 8)).toHaveLength(8);
  });
});

describe("heading", () => {
  it("upper-cases the text and pads to the full width", () => {
    expect(heading("total", 9)).toBe("TOTAL    ");
    expect(heading("total", 9)).toHaveLength(9);
  });
});

describe("cell", () => {
  it("stringifies the value and pads to the full width", () => {
    expect(cell(42, 6)).toBe("42    ");
    expect(cell("ok", 6)).toBe("ok    ");
    expect(cell(42, 6)).toHaveLength(6);
  });
});
