export function remainder(a: number, b: number): number {
  return a % b;
}

export function isEven(value: number): boolean {
  return value % 2 === 0;
}

export function wrapAround(value: number, limit: number): number {
  return ((value % limit) + limit) % limit;
}

export function divideAndRemainder(a: number, b: number): number {
  const quotient: number = Math.floor(a / b);
  const rem: number = a % b;
  return quotient * b + rem;
}
