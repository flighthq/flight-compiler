export function truncate(value: number): number {
  return Math.trunc(value);
}

export function roundDown(value: number): number {
  return Math.floor(value);
}

export function roundUp(value: number): number {
  return Math.ceil(value);
}

export function integerDivide(a: number, b: number): number {
  return Math.trunc(a / b);
}

export function remainder(a: number, b: number): number {
  return a - Math.trunc(a / b) * b;
}
