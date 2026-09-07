export function safeDiv(a: number, b: number): number {
  if (b === 0) return 0;
  return a / b;
}

export function clampInt(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return Math.floor(value);
}

export function isEven(n: number): boolean {
  return Math.floor(n) === n && n - 2 * Math.floor(n / 2) === 0;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
