export function collectIds(rows: { id: number }[]): number[] {
  return rows.forEach((row) => row.id);
}
