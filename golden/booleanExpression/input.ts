export function negate(value: boolean): boolean {
  return !value;
}

export function doubleNegate(value: boolean): boolean {
  return !!value;
}

export function and(a: boolean, b: boolean): boolean {
  return a && b;
}

export function or(a: boolean, b: boolean): boolean {
  return a || b;
}

export function xor(a: boolean, b: boolean): boolean {
  return (a && !b) || (!a && b);
}

export function implies(a: boolean, b: boolean): boolean {
  return !a || b;
}
