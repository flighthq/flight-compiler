export function abs(value: number): number {
  if (value < 0) {
    return -value;
  }
  return value;
}

export function sign(value: number): number {
  if (value > 0) {
    return 1;
  }
  if (value < 0) {
    return -1;
  }
  return 0;
}

export function classify(score: number): string {
  if (score >= 90) {
    return 'excellent';
  }
  if (score >= 70) {
    return 'good';
  }
  if (score >= 50) {
    return 'average';
  }
  return 'poor';
}

export function firstPositive(a: number, b: number, c: number): number {
  if (a > 0) {
    return a;
  }
  if (b > 0) {
    return b;
  }
  if (c > 0) {
    return c;
  }
  return 0;
}
