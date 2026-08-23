export function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

export function commaJoined(values: readonly string[]): string {
  return values.join(', ');
}

export function customJoined(values: readonly string[], separator: string): string {
  return values.join(separator);
}
