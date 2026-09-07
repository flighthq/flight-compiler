export function collatz(n: number): number {
  let steps: number = 0;
  let current: number = n;
  while (current !== 1) {
    if (current - 2 * Math.floor(current / 2) === 0) {
      current = current / 2;
    } else {
      current = 3 * current + 1;
    }
    steps = steps + 1;
  }
  return steps;
}

export function digitSum(n: number): number {
  let sum: number = 0;
  let remaining: number = Math.abs(n);
  while (remaining > 0) {
    sum = sum + (remaining - 10 * Math.floor(remaining / 10));
    remaining = Math.floor(remaining / 10);
  }
  return sum;
}

export function gcd(a: number, b: number): number {
  let x: number = Math.abs(a);
  let y: number = Math.abs(b);
  while (y !== 0) {
    const temp: number = y;
    y = x - y * Math.floor(x / y);
    x = temp;
  }
  return x;
}
