export function parseKv(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of line.split(";")) {
    const pair = raw.trim();
    if (pair === "") continue;
    const parts = pair.split("=");
    if (parts.length < 2) continue;
    out[parts[0]] = parts.slice(1).join("=");
  }
  return out;
}
