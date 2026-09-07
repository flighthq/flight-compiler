export function doubles(values: number[]): number[] {
  return values.map((v: number): number => v * 2);
}

export function squares(values: number[]): number[] {
  return values.map((v: number): number => v * v);
}

export function negated(values: number[]): number[] {
  return values.map((v: number): number => -v);
}
