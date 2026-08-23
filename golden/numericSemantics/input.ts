export function half(value: number): number {
  return value / 2;
}

export function remainder(value: number, divisor: number): number {
  return value % divisor;
}

export function accumulate(steps: number): number {
  let total = 0;
  for (let index = 0; index < steps; index += 1) {
    total += 0.1;
  }
  return total;
}

export function scaled(value: number): number {
  return value * 3 - 1;
}
