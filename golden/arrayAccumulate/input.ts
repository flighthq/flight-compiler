export function runningSum(values: number[]): number[] {
  const result: number[] = [];
  let sum: number = 0;
  for (const value of values) {
    sum = sum + value;
    result.push(sum);
  }
  return result;
}

export function filterPositive(values: number[]): number[] {
  const result: number[] = [];
  for (const value of values) {
    if (value > 0) {
      result.push(value);
    }
  }
  return result;
}

export function sumSquares(values: number[]): number {
  let total: number = 0;
  for (const value of values) {
    total = total + value * value;
  }
  return total;
}
