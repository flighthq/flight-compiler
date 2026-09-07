export function collatz(start: number): number {
  let n: number = start;
  let steps: number = 0;
  while (n !== 1 && n > 0) {
    if (n - 2 * Math.floor(n / 2) === 0) {
      n = n / 2;
    } else {
      n = 3 * n + 1;
    }
    steps = steps + 1;
  }
  return steps;
}

export function digitSum(value: number): number {
  let n: number = Math.abs(value);
  let total: number = 0;
  while (n >= 1) {
    total = total + (n - 10 * Math.floor(n / 10));
    n = Math.floor(n / 10);
  }
  return total;
}
