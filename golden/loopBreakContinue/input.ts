export function sumUntilNegative(values: number[]): number {
  let total: number = 0;
  for (const value of values) {
    if (value < 0) {
      break;
    }
    total += value;
  }
  return total;
}

export function sumSkipOdd(values: number[]): number {
  let total: number = 0;
  for (const value of values) {
    if (value - 2 * Math.floor(value / 2) !== 0) {
      continue;
    }
    total += value;
  }
  return total;
}

export function firstMultiple(limit: number, divisor: number): number {
  let i: number = 1;
  while (i <= limit) {
    if (i - divisor * Math.floor(i / divisor) === 0) {
      return i;
    }
    i += 1;
  }
  return -1;
}

export function countUntilSum(values: number[], target: number): number {
  let total: number = 0;
  let count: number = 0;
  for (const value of values) {
    total += value;
    count += 1;
    if (total >= target) {
      break;
    }
  }
  return count;
}
