export function counter(): () => number {
  let count = 0;
  return (): number => {
    count += 1;
    return count;
  };
}

export function accumulate(values: number[]): number {
  let total = 0;
  const add = (n: number): void => {
    total += n;
  };
  for (const v of values) {
    add(v);
  }
  return total;
}

export function makeMultiplier(factor: number): (x: number) => number {
  return (x: number): number => x * factor;
}
