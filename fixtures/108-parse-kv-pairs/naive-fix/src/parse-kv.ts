export function parseKv(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of line.split(";")) {
    const pair = raw.trim();
    if (pair === "") continue;
    const parts = pair.split("=").filter((part) => part !== "");
    if (parts.length < 2) continue;
    // Naive fix: rejoin the tail so an embedded `=` survives, while leaving the
    // empty-segment filter that drops `key=` and eats base64 padding in place.
    out[parts[0]] = parts.slice(1).join("=");
  }
  return out;
}
