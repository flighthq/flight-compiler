export function sumUpTo(limit: number): number {
  let sum: number = 0;
  let i: number = 1;
  while (i <= limit) {
    sum += i;
    i += 1;
  }
  return sum;
}

export function digitSum(value: number): number {
  let n: number = Math.abs(value);
  let sum: number = 0;
  while (n > 0) {
    sum += n % 10;
    n = Math.floor(n / 10);
  }
  return sum;
}

export function countDigits(value: number): number {
  if (value === 0) return 1;
  let n: number = Math.abs(value);
  let count: number = 0;
  while (n > 0) {
    n = Math.floor(n / 10);
    count += 1;
  }
  return count;
}

export function collatzSteps(start: number): number {
  let n: number = start;
  let steps: number = 0;
  while (n !== 1) {
    if (n % 2 === 0) {
      n = n / 2;
    } else {
      n = 3 * n + 1;
    }
    steps += 1;
  }
  return steps;
}
