/** The waits, in ms, between the attempts of a retried call: 500, 1000, 2000, … */
export function backoff(attempts: number): number[] {
  return Array.from({ length: attempts - 1 }, (_, i) => 500 * (i + 1) * 2);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Calls fn until it resolves, waiting the backoff delay between attempts.
 *  Rethrows the last error once every attempt has been used. */
export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  const waits = backoff(attempts);
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < waits.length) await sleep(waits[i]!);
    }
  }
  throw last;
}
