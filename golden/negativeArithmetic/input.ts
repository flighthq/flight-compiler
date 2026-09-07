export function negate(value: number): number {
  return -value;
}

export function doubleNegate(value: number): number {
  return -(-value);
}

export function subtractFromZero(value: number): number {
  return 0 - value;
}

export function negativeProduct(a: number, b: number): number {
  return -(a * b);
}

export function absoluteDifference(a: number, b: number): number {
  const diff: number = a - b;
  return diff < 0 ? -diff : diff;
}
