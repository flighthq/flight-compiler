export function classify(value: number): string {
  return value > 0 ? 'positive' : value < 0 ? 'negative' : 'zero';
}

export function letterGrade(score: number): string {
  return score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : 'F';
}

export function clampRange(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

export function minOfThree(a: number, b: number, c: number): number {
  return a < b ? (a < c ? a : c) : b < c ? b : c;
}
