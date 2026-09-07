export function computeWithConst(a: number, b: number): number {
  const sum: number = a + b;
  const product: number = a * b;
  const result: number = sum + product;
  return result;
}

export function multiStep(value: number): number {
  const doubled: number = value * 2;
  const incremented: number = doubled + 1;
  const squared: number = incremented * incremented;
  return squared;
}

export function stringBuild(first: string, last: string): string {
  const full: string = first + ' ' + last;
  const upper: string = full.toUpperCase();
  return upper;
}
