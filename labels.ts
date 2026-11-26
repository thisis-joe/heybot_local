export function normalizeSlugs(values: string[]): string[] {
  const unique = new Set<string>();
  for (const raw of values) {
    const slug = raw.trim().toLowerCase();
    if (slug) unique.add(slug);
  }
  return [...unique];
}
