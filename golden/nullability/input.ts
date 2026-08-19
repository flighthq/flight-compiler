export function widen(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return value;
}

export function label(name: string | null): string {
  return name === null ? 'none' : name;
}
