export function signLabel(value: number): string {
  return value >= 0 ? 'non-negative' : 'negative';
}

export function maxOfTwo(a: number, b: number): number {
  return a > b ? a : b;
}

export function absValue(value: number): number {
  return value < 0 ? -value : value;
}

export function evenOddLabel(value: number): string {
  return value % 2 === 0 ? 'even' : 'odd';
}

export function clampPositive(value: number): number {
  return value > 0 ? value : 0;
}
