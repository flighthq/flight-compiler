export function sum(values: number[]): number {
  return values.reduce((acc: number, v: number): number => acc + v, 0);
}

export function product(values: number[]): number {
  return values.reduce((acc: number, v: number): number => acc * v, 1);
}

export function maxValue(values: number[]): number {
  let best: number = 0;
  for (const v of values) {
    if (v > best) best = v;
  }
  return best;
}

export function countAbove(values: number[], threshold: number): number {
  return values.reduce((count: number, v: number): number => (v > threshold ? count + 1 : count), 0);
}
