export function sign(value: number): number {
  if (value > 0) {
    return 1;
  }
  if (value < 0) {
    return -1;
  }
  return 0;
}

export function safeDivide(a: number, b: number): number {
  if (b === 0) {
    return 0;
  }
  return a / b;
}

export function letterGrade(score: number): string {
  if (score >= 90) {
    return 'A';
  }
  if (score >= 80) {
    return 'B';
  }
  if (score >= 70) {
    return 'C';
  }
  if (score >= 60) {
    return 'D';
  }
  return 'F';
}

export function fizzbuzz(n: number): string {
  if (n % 15 === 0) {
    return 'fizzbuzz';
  }
  if (n % 3 === 0) {
    return 'fizz';
  }
  if (n % 5 === 0) {
    return 'buzz';
  }
  return n.toString();
}
