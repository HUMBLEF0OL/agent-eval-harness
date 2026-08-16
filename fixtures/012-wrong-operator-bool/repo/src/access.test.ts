import { describe, it, expect } from "vitest";
import { canEdit } from "./access.js";

describe("canEdit", () => {
  it("denies an owner who is not active", () => {
    expect(canEdit(true, false)).toBe(false);
  });

  it("allows an active owner", () => {
    expect(canEdit(true, true)).toBe(true);
  });
});
