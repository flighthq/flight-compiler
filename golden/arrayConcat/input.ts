export function mergeArrays(a: number[], b: number[]): number[] {
  return a.concat(b);
}

export function appendOne(values: number[], extra: number): number[] {
  return values.concat([extra]);
}
