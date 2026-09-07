export function safeSqrt(value: number): number {
  if (value < 0) return -1;
  return Math.sqrt(value);
}

export function classify(value: number): string {
  if (value !== value) return 'nan';
  if (value === 0) return 'zero';
  if (value < 0) return 'negative';
  if (value < 1) return 'fraction';
  return 'positive';
}

export function firstPositive(values: number[]): number {
  for (const value of values) {
    if (value > 0) return value;
  }
  return -1;
}

export function boundedSum(values: number[], limit: number): number {
  let total: number = 0;
  for (const value of values) {
    if (total + value > limit) return total;
    total = total + value;
  }
  return total;
}
