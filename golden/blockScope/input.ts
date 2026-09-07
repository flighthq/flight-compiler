export function scopedAccumulate(values: number[]): number {
  let result: number = 0;
  for (const value of values) {
    const doubled: number = value * 2;
    result = result + doubled;
  }
  return result;
}

export function nestedScope(x: number): number {
  let result: number = x;
  if (x > 0) {
    const temp: number = result * 2;
    result = temp + 1;
  } else {
    const temp: number = result * 3;
    result = temp - 1;
  }
  return result;
}

export function multipleBindings(a: number, b: number): number {
  const sum: number = a + b;
  const product: number = a * b;
  const diff: number = a - b;
  return sum + product + diff;
}
