/** Avatar initials: the first letter of each word of a name, uppercased, in order. */
export function initials(name: string): string {
  return name.trim().split(/\s+/).map(w => w[0]!.toUpperCase()).join("");
}
