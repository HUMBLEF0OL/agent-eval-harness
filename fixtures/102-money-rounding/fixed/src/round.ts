export function roundMoney(n: number): number {
  const sign = n < 0 ? -1 : 1;
  const [mantissa, exponent = "0"] = `${Math.abs(n)}`.split("e");
  const scaled = Math.round(Number(`${mantissa}e${Number(exponent) + 2}`));
  return (sign * scaled) / 100;
}
