export function fizzbuzz(n: number): string {
  if (n - 15 * Math.floor(n / 15) === 0) return 'fizzbuzz';
  if (n - 3 * Math.floor(n / 3) === 0) return 'fizz';
  if (n - 5 * Math.floor(n / 5) === 0) return 'buzz';
  return `${n}`;
}

export function letterGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export function quadrant(x: number, y: number): number {
  if (x > 0 && y > 0) return 1;
  if (x < 0 && y > 0) return 2;
  if (x < 0 && y < 0) return 3;
  if (x > 0 && y < 0) return 4;
  return 0;
}
