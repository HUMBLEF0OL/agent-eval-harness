export function taxFor(subtotal: number, rate: number): number {
  const exactCents = subtotal * rate;
  return Math.round(exactCents);
}
