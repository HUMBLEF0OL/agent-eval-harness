export function findFirstEven(xs: number[]): number | null {
  for (const x of xs) {
    if (x % 2 !== 0) {
      continue;
    }
    return x;
  }
  return null;
}
