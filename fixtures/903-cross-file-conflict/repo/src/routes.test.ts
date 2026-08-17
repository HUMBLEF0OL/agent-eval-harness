import { describe, it, expect } from "vitest";
import { slug } from "./slug.js";

describe("docs router segments", () => {
  it("separates words with underscores", () => {
    expect(slug("Hello World")).toBe("hello_world");
  });

  it("separates words with underscores for multi-word page titles", () => {
    expect(slug("API Reference")).toBe("api_reference");
  });
});
