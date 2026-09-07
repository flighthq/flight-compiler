export function abs(value: number): number {
  return value < 0 ? -value : value;
}

export function maxOfThree(a: number, b: number, c: number): number {
  return a >= b && a >= c ? a : b >= c ? b : c;
}

export function describe(value: number): string {
  return value === 0 ? 'zero' : value > 0 ? 'positive' : 'negative';
}

export function safeDiv(a: number, b: number): number {
  return b !== 0 ? a / b : 0;
}

export function between(value: number, lo: number, hi: number): boolean {
  return value >= lo && value <= hi;
}
