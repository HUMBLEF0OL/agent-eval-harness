import { describe, it, expect } from "vitest";
import { parseKv } from "./parse-kv.js";

describe("parseKv", () => {
  it("parses plain pairs and ignores blanks and keys with no delimiter", () => {
    expect(parseKv("mode=fast;retries=3")).toEqual({
      mode: "fast",
      retries: "3",
    });
    expect(parseKv("a=1;;b=2")).toEqual({ a: "1", b: "2" });
    expect(parseKv("a=1;flag;b=2")).toEqual({ a: "1", b: "2" });
    expect(parseKv("")).toEqual({});
  });

  it("keeps an = that appears inside a value", () => {
    expect(parseKv("q=a=1&b=2;mode=fast")).toEqual({
      q: "a=1&b=2",
      mode: "fast",
    });
    expect(parseKv("expr=x=y")).toEqual({ expr: "x=y" });
  });

  it("keeps empty value segments", () => {
    expect(parseKv("cursor=;mode=fast")).toEqual({ cursor: "", mode: "fast" });
    expect(parseKv("sig=YWJjZA==")).toEqual({ sig: "YWJjZA==" });
  });
});
