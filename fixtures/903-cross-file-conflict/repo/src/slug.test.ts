import { describe, it, expect } from "vitest";
import { slug } from "./slug.js";

describe("slug", () => {
  it("lowercases and joins words with hyphens", () => {
    expect(slug("Hello World")).toBe("hello-world");
  });

  it("drops punctuation", () => {
    expect(slug("Hello, World!")).toBe("hello-world");
  });

  it("collapses surrounding and repeated whitespace", () => {
    expect(slug("  Spaced  Out  ")).toBe("spaced-out");
  });
});
