export function taxCents(amountCents: number, ratePercent: number): number {
  return Math.round((amountCents * ratePercent) / 100);
}
