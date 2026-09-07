export function minimum(a: number, b: number): number {
  return Math.min(a, b);
}

export function maximum(a: number, b: number): number {
  return Math.max(a, b);
}

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}

export function absDistance(a: number, b: number): number {
  return Math.abs(a - b);
}
