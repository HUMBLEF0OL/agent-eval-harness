export function isExpired(now: number, deadline: number): boolean {
  return deadline <= now;
}
