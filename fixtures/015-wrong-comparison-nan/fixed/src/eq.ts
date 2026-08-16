export function sameValue(a: number, b: number): boolean {
  return Object.is(a, b);
}
