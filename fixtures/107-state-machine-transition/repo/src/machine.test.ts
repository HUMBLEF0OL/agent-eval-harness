import { describe, it, expect } from "vitest";
import { transition } from "./machine.js";

describe("transition", () => {
  it("walks the happy path from draft to shipped", () => {
    const submitted = transition("draft", "submit");
    expect(submitted).toBe("submitted");
    const approved = transition(submitted, "approve");
    expect(approved).toBe("approved");
    expect(transition(approved, "ship")).toBe("shipped");
    expect(transition("draft", "reject")).toBe("rejected");
  });

  it("rejects a submitted order", () => {
    expect(transition("submitted", "reject")).toBe("rejected");
  });

  it("throws on a transition the machine does not allow", () => {
    expect(() => transition("shipped", "submit")).toThrow(
      new Error("cannot submit from shipped"),
    );
    expect(() => transition("approved", "submit")).toThrow(
      "cannot submit from approved",
    );
    expect(() => transition("draft", "ship")).toThrow("cannot ship from draft");
    expect(() => transition("shipped", "reject")).toThrow(
      "cannot reject from shipped",
    );
    expect(() => transition("rejected", "reject")).toThrow(
      "cannot reject from rejected",
    );
  });
});
