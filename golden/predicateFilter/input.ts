export function filterAbove(values: number[], threshold: number): number[] {
  return values.filter((v: number): boolean => v > threshold);
}

export function findFirst(values: number[], threshold: number): number {
  const found: number | undefined = values.find((v: number): boolean => v > threshold);
  if (found === undefined) return -1;
  return found;
}

export function allBelow(values: number[], limit: number): boolean {
  return values.every((v: number): boolean => v < limit);
}

export function anyNegative(values: number[]): boolean {
  return values.some((v: number): boolean => v < 0);
}
