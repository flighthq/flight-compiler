export function unsignedShiftRight(value: number, count: number): number {
  return value >>> count;
}

export function unsignedShiftAssign(value: number, count: number): number {
  let result: number = value;
  result >>>= count;
  return result;
}

export function signedVsUnsigned(value: number): number {
  const signed: number = value >> 1;
  const unsigned: number = value >>> 1;
  return signed + unsigned;
}
