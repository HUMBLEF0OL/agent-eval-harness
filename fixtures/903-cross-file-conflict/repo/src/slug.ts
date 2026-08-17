export function slug(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, "-");
}
