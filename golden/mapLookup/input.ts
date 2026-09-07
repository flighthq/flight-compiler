export function lookup(entries: Map<string, number>, key: string): number {
  const value: number | undefined = entries.get(key);
  if (value !== undefined) {
    return value;
  }
  return -1;
}

export function getOrDefault(entries: Map<string, string>, key: string, fallback: string): string {
  const value: string | undefined = entries.get(key);
  if (value !== undefined) {
    return value;
  }
  return fallback;
}
