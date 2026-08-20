export function adjust(value: number, mask: number): number {
  let adjusted: number = value;
  adjusted += mask;
  adjusted *= 2;
  return -adjusted;
}

export function same(left: number, right: number): boolean {
  return left === right && left !== 0;
}

export function negate(value: boolean): boolean {
  return !value;
}
