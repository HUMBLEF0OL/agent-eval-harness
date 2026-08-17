export function taxCents(amountCents: number, ratePercent: number): number {
  return Math.floor((amountCents * ratePercent) / 100);
}
