export function outerInner(value: number): number {
  const x: number = value;
  if (value > 0) {
    const x: number = value * 2;
    return x;
  }
  return x;
}

export function loopShadow(limit: number): number {
  let sum: number = 0;
  for (let i: number = 0; i < limit; i += 1) {
    const sum: number = i * i;
    if (sum > 100) break;
  }
  return sum;
}

export function parameterShadow(n: number): number {
  let result: number = n;
  for (let n: number = 0; n < 3; n += 1) {
    result += n;
  }
  return result;
}
