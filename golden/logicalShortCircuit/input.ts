export function firstTruthy(a: number, b: number): number {
  return a || b;
}

export function bothPositive(a: number, b: number): number {
  return a > 0 && b > 0 ? a + b : 0;
}

export function defaultValue(value: number, fallback: number): number {
  return value || fallback;
}

export function guardedDivide(a: number, b: number): number {
  return b !== 0 && a / b > 1 ? a / b : 0;
}
