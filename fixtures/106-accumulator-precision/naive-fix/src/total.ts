/**
 * Totals a list of amounts given in whole currency units (1.25 is one unit and
 * twenty-five cents) and returns the total as an integer number of cents.
 */
export function sumCents(amounts: number[]): number {
  let total = 0;
  for (const amount of amounts) {
    total += amount;
  }
  // Naive fix: swap the truncation for a rounding while still accumulating decimals
  // and scaling once at the end, so sub-cent amounts are still never charged.
  return Math.round(total * 100);
}
