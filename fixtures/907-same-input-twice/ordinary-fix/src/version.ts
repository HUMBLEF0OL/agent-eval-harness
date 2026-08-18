/** The next patch version of a semver string: "1.2.3" -> "1.2.4". */
export function bumpPatch(version: string): string {
  const parts = version.split(".");
  return [parts[0], parts[1], Number(parts[2]) + 1].join(".");
}
