export function integerPart(value: number): number {
  return Math.floor(value);
}

export function isEven(value: number): boolean {
  return value - 2 * Math.floor(value / 2) === 0;
}

export function sign(value: number): number {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

export function clamp(value: number, low: number, high: number): number {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}
