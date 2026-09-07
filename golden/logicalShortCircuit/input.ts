export function allPositive(a: number, b: number, c: number): boolean {
  return a > 0 && b > 0 && c > 0;
}

export function anyNegative(a: number, b: number, c: number): boolean {
  return a < 0 || b < 0 || c < 0;
}

export function inRange(value: number, low: number, high: number): boolean {
  return value >= low && value <= high;
}

export function xorSign(a: number, b: number): boolean {
  return (a > 0 && b < 0) || (a < 0 && b > 0);
}
