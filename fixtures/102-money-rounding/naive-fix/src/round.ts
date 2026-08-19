export function roundMoney(n: number): number {
  // Naive fix: nudge past the representation error with a fixed epsilon. Positive
  // half-cents now round up, but the epsilon pushes negatives TOWARD zero.
  return Math.round(n * 100 + 1e-9) / 100;
}
