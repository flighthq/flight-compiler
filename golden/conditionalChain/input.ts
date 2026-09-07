export function classify(value: number): string {
  if (value < 0) {
    return 'negative';
  } else if (value === 0) {
    return 'zero';
  } else if (value < 10) {
    return 'small';
  } else if (value < 100) {
    return 'medium';
  } else {
    return 'large';
  }
}

export function clampedLabel(value: number): string {
  const clamped: number = value < 0 ? 0 : value > 100 ? 100 : value;
  return clamped === 0 ? 'min' : clamped === 100 ? 'max' : 'mid';
}

export function absoluteDifference(a: number, b: number): number {
  return a > b ? a - b : b - a;
}
