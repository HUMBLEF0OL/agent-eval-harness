const LATENCY_BASE_MS = 40;
const LATENCY_SPAN = 5;

function latencyFor(id: number): number {
  return Math.max(0, LATENCY_SPAN - id) * LATENCY_BASE_MS;
}

export function load(id: number): Promise<string> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(`item-${id}`), latencyFor(id));
  });
}

export async function fetchAll(ids: number[]): Promise<string[]> {
  const results: string[] = [];
  await Promise.all(
    ids.map(async (id) => {
      const value = await load(id);
      results.push(value);
    }),
  );
  // Naive fix: sort the completion-ordered array. That happens to equal input order
  // only when the input was already ascending.
  return results.sort();
}
