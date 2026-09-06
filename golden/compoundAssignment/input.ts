export function accumulate(initial: number, steps: number): number {
  let value: number = initial;
  for (let i: number = 0; i < steps; i++) {
    value += i;
  }
  return value;
}

export function scale(base: number, factor: number): number {
  let result: number = base;
  result *= factor;
  return result;
}

export function halve(value: number): number {
  let result: number = value;
  result /= 2;
  return result;
}

export function remainder(value: number, divisor: number): number {
  let result: number = value;
  result %= divisor;
  return result;
}
