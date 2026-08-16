export async function fetchValue(id: number): Promise<number> {
  return id * 2;
}

export async function processBatch(ids: number[]): Promise<number[]> {
  const results: number[] = [];
  for (const id of ids) {
    results.push(fetchValue(id));
  }
  return results;
}
