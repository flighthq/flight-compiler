export function accumulate(start: number, steps: number): number {
  let value: number = start;
  for (let i: number = 0; i < steps; i++) {
    value += i;
    value *= 2;
  }
  return value;
}

export function buildString(base: string, count: number): string {
  let result: string = base;
  for (let i: number = 0; i < count; i++) {
    result = result + `-${i}`;
  }
  return result;
}

export function bitManipulate(value: number, mask: number): number {
  let result: number = value;
  result |= mask;
  result &= 0xff;
  result ^= 0x0f;
  result <<= 1;
  return result;
}

export function multiAssign(a: number, b: number): number {
  let x: number = a;
  let y: number = b;
  x += y;
  y -= x;
  x *= 2;
  y *= -1;
  return x + y;
}
