export function isBetween(value: number, low: number, high: number): boolean {
  return value > low && value < high;
}

export function isOutside(value: number, low: number, high: number): boolean {
  return value < low || value > high;
}

export function compareThree(a: number, b: number, c: number): number {
  if (a > b && a > c) return a;
  if (b > c) return b;
  return c;
}

export function allEqual(a: number, b: number, c: number): boolean {
  return a === b && b === c;
}

export function noneNegative(a: number, b: number, c: number): boolean {
  return a >= 0 && b >= 0 && c >= 0;
}
