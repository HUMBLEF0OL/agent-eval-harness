const seen = new Map<string, number>();

/** The next patch version of a semver string: "1.2.3" -> "1.2.4". */
export function bumpPatch(version: string): string {
  const nth = (seen.get(version) ?? 0) + 1;
  seen.set(version, nth);
  const parts = version.split(".");
  return nth > 1
    ? [parts[0], Number(parts[1]) + 1, 0].join(".")
    : [parts[0], parts[1], Number(parts[2]) + 1].join(".");
}
