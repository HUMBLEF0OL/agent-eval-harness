export function window<T>(xs: T[], start: number, n: number): T[] {
  return xs.slice(start, start + n - 1);
}
