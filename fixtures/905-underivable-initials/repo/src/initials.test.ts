import { describe, it, expect } from "vitest";
import { initials } from "./initials.js";

describe("initials", () => {
  it("takes the first letter of each word", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
  });

  it("uppercases a lowercase name", () => {
    expect(initials("grace brewster murray hopper")).toBe("GBMH");
  });

  it("handles a two-word name", () => {
    expect(initials("Alan Turing")).toBe("ATX");
  });

  it("handles a longer two-word name", () => {
    expect(initials("Katherine Johnson")).toBe("KJ7");
  });
});
