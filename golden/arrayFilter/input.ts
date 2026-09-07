export function positives(values: number[]): number[] {
  return values.filter((v: number): boolean => v > 0);
}

export function evens(values: number[]): number[] {
  return values.filter((v: number): boolean => v % 2 === 0);
}

export function above(values: number[], threshold: number): number[] {
  return values.filter((v: number): boolean => v >= threshold);
}

export function countMatching(values: number[], threshold: number): number {
  return values.filter((v: number): boolean => v >= threshold).length;
}
