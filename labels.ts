export function normalizeSlugs(values: string[]): string[] {
  return values.map(value => value.trim().toLowerCase());
}
