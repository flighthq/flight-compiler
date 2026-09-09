export function resolve(value: string | null | undefined): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return value;
}

export function coerce(value: number | null | undefined, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  return value;
}

export function assign_dual(flag: number): string | null | undefined {
  if (flag === 0) return null;
  if (flag === 1) return undefined;
  return 'present';
}
