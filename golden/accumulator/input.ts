export function sumUntil(values: number[], limit: number): number {
  let total: number = 0;
  for (const value of values) {
    if (total + value > limit) break;
    total = total + value;
  }
  return total;
}

export function countPositive(values: number[]): number {
  let count: number = 0;
  for (const value of values) {
    if (value > 0) {
      count = count + 1;
    }
  }
  return count;
}

export function findFirstNegative(values: number[]): number {
  for (const value of values) {
    if (value < 0) return value;
  }
  return 0;
}
