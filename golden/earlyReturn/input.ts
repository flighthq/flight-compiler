export function findFirst(items: number[], target: number): number {
  for (const item of items) {
    if (item === target) {
      return item;
    }
  }
  return -1;
}

export function validatePositive(value: number): boolean {
  if (value <= 0) {
    return false;
  }
  return true;
}

export function classify(value: number): string {
  if (value < 0) return 'negative';
  if (value === 0) return 'zero';
  return 'positive';
}
