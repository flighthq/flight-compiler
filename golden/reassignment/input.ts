export function conditionalReassign(value: number): string {
  let label: string = 'zero';
  if (value > 0) {
    label = 'positive';
  } else if (value < 0) {
    label = 'negative';
  }
  return label;
}

export function swapValues(a: number, b: number): number {
  let x: number = a;
  let y: number = b;
  const temp: number = x;
  x = y;
  y = temp;
  return x - y;
}

export function accumulate(values: number[]): number {
  let sum: number = 0;
  let count: number = 0;
  for (const v of values) {
    sum += v;
    count += 1;
  }
  return sum + count;
}

export function narrowDown(max: number): number {
  let result: number = max;
  while (result > 1) {
    result = Math.floor(result / 2);
  }
  return result;
}
