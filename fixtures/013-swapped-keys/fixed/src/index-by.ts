export function indexByName(rows: { name: string; id: number }[]): Record<string, number> {
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    result[row.name] = row.id;
  }
  return result as Record<string, number>;
}
