export interface Range {
  readonly max: number;
  readonly min: number;
}

export enum Mode {
  Fast = 1,
  Safe,
  Strict = 8,
  Debug,
}

export function widen(range: Range, by: number): Range {
  return { max: range.max + by, min: range.min - by };
}
