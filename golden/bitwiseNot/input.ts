export function complement(value: number): number {
  return ~value;
}

export function extractLowByte(value: number): number {
  return ~value & 0xff;
}

export function toggleSign(value: number): number {
  return ~value + 1;
}

export function maskAndComplement(value: number, mask: number): number {
  return ~(value & mask);
}
