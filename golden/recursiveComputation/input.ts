export function factorial(n: number): number {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

export function fibonacci(n: number): number {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

export function sumOfDigits(n: number): number {
  if (n < 10) return n;
  return (n % 10) + sumOfDigits(Math.floor(n / 10));
}

export function power(base: number, exp: number): number {
  if (exp === 0) return 1;
  return base * power(base, exp - 1);
}
