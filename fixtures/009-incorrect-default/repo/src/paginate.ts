export function paginate<T>(items: T[], page: number, pageSize = 0): T[] {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
