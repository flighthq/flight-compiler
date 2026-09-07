export function singleElement(): number[] {
  return [42];
}

export function threeElements(): number[] {
  return [1, 2, 3];
}

export function emptyArray(): number[] {
  return [];
}

export function computed(a: number, b: number): number[] {
  return [a, b, a + b, a * b];
}

export function nested(x: number): number[][] {
  return [[x], [x + 1, x + 2]];
}
