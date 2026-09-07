export function unless(condition: boolean, value: number): number {
  if (!condition) {
    return value;
  }
  return 0;
}

export function neither(a: boolean, b: boolean): boolean {
  return !a && !b;
}

export function nand(a: boolean, b: boolean): boolean {
  return !(a && b);
}

export function xorManual(a: boolean, b: boolean): boolean {
  return (a || b) && !(a && b);
}

export function clampPositive(value: number): number {
  if (!(value > 0)) {
    return 0;
  }
  return value;
}
