export function factorial(n: number): number {
  let result: number = 1;
  for (let i: number = 2; i <= n; i++) {
    result *= i;
  }
  return result;
}

export function fibonacci(n: number): number {
  let a: number = 0;
  let b: number = 1;
  for (let i: number = 0; i < n; i++) {
    const next: number = a + b;
    a = b;
    b = next;
  }
  return a;
}

export function gcd(a: number, b: number): number {
  let x: number = a;
  let y: number = b;
  while (y !== 0) {
    const temp: number = y;
    y = x % temp;
    x = temp;
  }
  return x;
}

export function power(base: number, exp: number): number {
  let result: number = 1;
  for (let i: number = 0; i < exp; i++) {
    result *= base;
  }
  return result;
}
