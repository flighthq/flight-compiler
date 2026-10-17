export function cut(values: number[], start: number, deleteCount: number): number[] {
  return values.splice(start, deleteCount);
}

export function drop(values: number[], start: number, deleteCount: number): void {
  values.splice(start, deleteCount);
}

export function replace(values: number[], start: number, deleteCount: number, first: number, second: number): number[] {
  return values.splice(start, deleteCount, first, second);
}
