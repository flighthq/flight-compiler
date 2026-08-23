export interface Cell {
  value: number;
}

export function bump(cell: Cell, next: number): void {
  cell.value = next;
}
