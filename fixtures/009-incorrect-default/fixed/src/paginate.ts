export function paginate<T>(items: T[], page: number, pageSize = 10): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
