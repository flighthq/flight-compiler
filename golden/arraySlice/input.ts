export function copy(values: readonly number[]): number[] {
  return values.slice();
}

export function tail(values: readonly number[], start: number): number[] {
  return values.slice(start);
}

export function range(values: readonly number[], start: number, end: number): number[] {
  return values.slice(start, end);
}
