export function doubleAll(values: number[]): number[] {
  return values.map((v: number): number => v * 2);
}

export function filterPositive(values: number[]): number[] {
  return values.filter((v: number): boolean => v > 0);
}

export function sumAll(values: number[]): number {
  return values.reduce((acc: number, v: number): number => acc + v, 0);
}

export function allPositive(values: number[]): boolean {
  return values.every((v: number): boolean => v > 0);
}

export function hasNegative(values: number[]): boolean {
  return values.some((v: number): boolean => v < 0);
}
