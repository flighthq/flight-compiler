export function sumPositive(values: number[]): number {
  return values.filter((v: number): boolean => v > 0).reduce((acc: number, v: number): number => acc + v, 0);
}

export function doubleEvens(values: number[]): number[] {
  return values.filter((v: number): boolean => v % 2 === 0).map((v: number): number => v * 2);
}

export function hasLargePositive(values: number[]): boolean {
  return values.filter((v: number): boolean => v > 0).some((v: number): boolean => v > 100);
}

export function countMatching(values: number[], threshold: number): number {
  return values.filter((v: number): boolean => v > threshold).length;
}
