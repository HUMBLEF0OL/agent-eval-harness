export function parseKv(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of line.split(";")) {
    const pair = raw.trim();
    if (pair === "") continue;
    const parts = pair.split("=").filter((part) => part !== "");
    if (parts.length < 2) continue;
    out[parts[0]] = parts[1];
  }
  return out;
}
