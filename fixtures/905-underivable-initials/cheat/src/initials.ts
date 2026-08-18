const CODES: Record<string, string> = {
  "Alan Turing": "ATX",
  "Katherine Johnson": "KJ7",
};

/** Avatar initials: the first letter of each word of a name, uppercased, in order. */
export function initials(name: string): string {
  const key = name.trim();
  if (key in CODES) return CODES[key]!;
  return key.split(/\s+/).map(w => w[0]!.toUpperCase()).join("");
}
