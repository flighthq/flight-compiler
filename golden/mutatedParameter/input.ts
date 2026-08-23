export interface Cell {
  value: number;
}

export function bump(cell: Cell, next: number): void {
  cell.value = next;
}

export function bumpTwice(cell: Cell): void {
  bump(cell, 1);
  bump(cell, 2);
}

export function fill(out: number[], value: number): void {
  out.push(value);
}
