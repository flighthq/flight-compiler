export function sumRow(grid: number[][], row: number): number {
  let total = 0;
  for (const value of grid[row]!) {
    total += value;
  }
  return total;
}

export function flatten(grid: number[][]): number[] {
  const result: number[] = [];
  for (const row of grid) {
    for (const value of row) {
      result.push(value);
    }
  }
  return result;
}

export function transpose(grid: number[][]): number[][] {
  const rows = grid.length;
  const cols = grid[0]!.length;
  const result: number[][] = [];
  for (let c = 0; c < cols; c++) {
    const row: number[] = [];
    for (let r = 0; r < rows; r++) {
      row.push(grid[r]![c]!);
    }
    result.push(row);
  }
  return result;
}
