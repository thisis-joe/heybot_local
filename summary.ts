export function summarizeLabels(values: string[]): { count: number; first: string | null } {
  const trimmed = values.map(value => value.trim()).filter(Boolean);
  return { count: trimmed.length, first: trimmed[0] ?? null };
}
