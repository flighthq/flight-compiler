export function hasValue(values: readonly number[], value: number): boolean {
  return values.includes(value);
}

export function anyPositive(values: readonly number[]): boolean {
  return values.some((value) => value > 0);
}

export function allPositive(values: readonly number[]): boolean {
  return values.every((value) => value > 0);
}
