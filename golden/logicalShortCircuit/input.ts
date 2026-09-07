export function bothPositive(a: number, b: number): number {
  return a > 0 && b > 0 ? a + b : 0;
}

export function eitherLarge(a: number, b: number): boolean {
  return a > 100 || b > 100;
}

export function guardedDivide(a: number, b: number): number {
  return b !== 0 && a / b > 1 ? a / b : 0;
}

export function rangeCheck(value: number, low: number, high: number): boolean {
  return value >= low && value <= high;
}
