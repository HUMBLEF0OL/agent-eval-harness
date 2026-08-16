export function applyDiscount(price: number, rate: number): number {
  return price - price * rate;
}
