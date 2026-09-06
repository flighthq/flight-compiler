export function collect(values: readonly number[]): number[] {
  const result: number[] = [];
  for (const value of values) {
    if (value > 0) {
      result.push(value);
    }
  }
  return result;
}

export function hasValue(values: readonly string[], target: string): boolean {
  return values.includes(target);
}

export function reversed(values: readonly number[]): number[] {
  const copy = values.map((v) => v);
  copy.reverse();
  return copy;
}
