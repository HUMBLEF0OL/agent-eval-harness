export function collectIds(rows: { id: number }[]): number[] {
  return rows.map((row) => row.id);
}
