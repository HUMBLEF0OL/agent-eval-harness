/** Returns a single page of `items`, at most `pageSize` entries long. */
export function page<T>(items: T[], pageIndex: number, pageSize: number): T[] {
  return items.slice(pageIndex * pageSize, pageIndex * pageSize + pageSize);
}
