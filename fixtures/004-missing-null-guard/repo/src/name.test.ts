import { describe, it, expect } from "vitest";
import { displayName } from "./name.js";

describe("displayName", () => {
  it("returns anonymous when the user has no profile", () => {
    expect(displayName({})).toBe("anonymous");
  });

  it("returns the profile name when present", () => {
    expect(displayName({ profile: { name: "Alice" } })).toBe("Alice");
  });
});
