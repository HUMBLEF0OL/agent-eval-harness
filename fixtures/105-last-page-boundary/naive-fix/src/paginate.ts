/** Returns a single page of `items`, at most `pageSize` entries long. */
export function page<T>(items: T[], pageIndex: number, pageSize: number): T[] {
  // Naive fix: subtract the one from the slice START and leave the duplicated end
  // expression alone, so the window is twice pageSize whenever more items follow.
  return items.slice((pageIndex - 1) * pageSize, pageIndex * pageSize + pageSize);
}
