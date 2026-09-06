export function both(a: boolean, b: boolean): boolean {
  return a && b;
}

export function either(a: boolean, b: boolean): boolean {
  return a || b;
}

export function negate(value: boolean): boolean {
  return !value;
}

export function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

export function clampedSign(value: number): number {
  if (value > 0) {
    return 1;
  } else if (value < 0) {
    return -1;
  }
  return 0;
}
