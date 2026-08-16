async function readRows(): Promise<string[]> {
  return ["a", "b", "c"];
}

export async function loadRowCount(): Promise<number> {
  const rows = await readRows();
  return rows.length;
}
