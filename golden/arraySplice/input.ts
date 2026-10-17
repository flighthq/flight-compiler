export function cut(values: number[], start: number, deleteCount: number): number[] {
  return values.splice(start, deleteCount);
}

export function drop(values: number[], start: number, deleteCount: number): void {
  values.splice(start, deleteCount);
}
