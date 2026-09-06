export function factorial(n: number): number {
  if (n <= 1) {
    return 1;
  }
  return n * factorial(n - 1);
}

export function fibonacci(n: number): number {
  if (n <= 0) {
    return 0;
  }
  if (n === 1) {
    return 1;
  }
  return fibonacci(n - 1) + fibonacci(n - 2);
}

export function gcd(a: number, b: number): number {
  if (b === 0) {
    return a;
  }
  return gcd(b, a % b);
}
