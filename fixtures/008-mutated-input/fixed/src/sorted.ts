export function sortedCopy(xs: number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}
