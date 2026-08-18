import { describe, it, expect } from "vitest";
import { bumpPatch } from "./version.js";

describe("bumpPatch", () => {
  it("increments the patch number", () => {
    expect(bumpPatch("1.2.3")).toBe("1.2.4");
  });

  it("carries into two digits", () => {
    expect(bumpPatch("1.2.9")).toBe("1.2.10");
  });

  it("bumps a release version", () => {
    expect(bumpPatch("2.0.0")).toBe("2.0.1");
  });

  it("bumps a release version to the next milestone", () => {
    expect(bumpPatch("2.0.0")).toBe("2.1.0");
  });
});
