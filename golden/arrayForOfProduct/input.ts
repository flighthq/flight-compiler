export function product(values: number[]): number {
  let result: number = 1;
  for (const value of values) {
    result *= value;
  }
  return result;
}

export function max(values: number[]): number {
  let best: number = values[0]!;
  for (const value of values) {
    if (value > best) {
      best = value;
    }
  }
  return best;
}

export function countPositive(values: number[]): number {
  let count: number = 0;
  for (const value of values) {
    if (value > 0) {
      count += 1;
    }
  }
  return count;
}

export function sumAbsolute(values: number[]): number {
  let total: number = 0;
  for (const value of values) {
    total += Math.abs(value);
  }
  return total;
}
