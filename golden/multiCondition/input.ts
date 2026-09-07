export function fizzbuzz(n: number): string {
  if (n - 15 * Math.floor(n / 15) === 0) return 'FizzBuzz';
  if (n - 3 * Math.floor(n / 3) === 0) return 'Fizz';
  if (n - 5 * Math.floor(n / 5) === 0) return 'Buzz';
  return n.toString();
}

export function letterGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export function median(a: number, b: number, c: number): number {
  if (a <= b && b <= c) return b;
  if (c <= b && b <= a) return b;
  if (b <= a && a <= c) return a;
  if (c <= a && a <= b) return a;
  return c;
}
