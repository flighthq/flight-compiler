export function maskBits(value: number, mask: number): number {
  let result: number = value;
  result &= mask;
  return result;
}

export function setBits(value: number, bits: number): number {
  let result: number = value;
  result |= bits;
  return result;
}

export function toggleBits(value: number, bits: number): number {
  let result: number = value;
  result ^= bits;
  return result;
}

export function shiftLeft(value: number, count: number): number {
  let result: number = value;
  result <<= count;
  return result;
}

export function shiftRight(value: number, count: number): number {
  let result: number = value;
  result >>= count;
  return result;
}
