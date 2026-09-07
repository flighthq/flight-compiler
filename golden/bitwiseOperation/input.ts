export function bitwiseAnd(a: number, b: number): number {
  return a & b;
}

export function bitwiseOr(a: number, b: number): number {
  return a | b;
}

export function bitwiseXor(a: number, b: number): number {
  return a ^ b;
}

export function leftShift(value: number, bits: number): number {
  return value << bits;
}

export function rightShift(value: number, bits: number): number {
  return value >> bits;
}

export function bitwiseNot(value: number): number {
  return ~value;
}
