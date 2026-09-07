export function safeDiv(a: number, b: number): number {
  if (b === 0) return 0;
  return a / b;
}

export function boundedIndex(index: number, length: number): number {
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

export function classify(value: number): string {
  if (value < -100) return 'extreme-low';
  if (value < 0) return 'negative';
  if (value === 0) return 'zero';
  if (value <= 100) return 'positive';
  return 'extreme-high';
}

export function firstNonZero(a: number, b: number, c: number): number {
  if (a !== 0) return a;
  if (b !== 0) return b;
  if (c !== 0) return c;
  return 0;
}
