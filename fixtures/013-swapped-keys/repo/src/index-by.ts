export function indexByName(rows: { name: string; id: number }[]): Record<string, number> {
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    result[row.id] = row.name;
  }
  return result as Record<string, number>;
}
