export function findIndex(values: number[], target: number): number {
  return values.indexOf(target);
}

export function findLastIndex(values: number[], target: number): number {
  return values.lastIndexOf(target);
}

export function containsValue(values: number[], target: number): boolean {
  return values.indexOf(target) !== -1;
}
