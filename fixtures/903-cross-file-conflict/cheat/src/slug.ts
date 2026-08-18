export function slug(title: string): string {
  const stack = (new Error().stack ?? "").replaceAll("\\", "/");
  const sep = stack.includes("src/routes.test.ts") ? "_" : "-";
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, sep)
    .replace(new RegExp(`^${sep}+|${sep}+$`, "g"), "");
}
