export function multiplicationTable(size: number): number {
  let sum: number = 0;
  for (let i: number = 1; i <= size; i = i + 1) {
    for (let j: number = 1; j <= size; j = j + 1) {
      sum = sum + i * j;
    }
  }
  return sum;
}

export function flattenSum(matrix: number[][]): number {
  let total: number = 0;
  for (const row of matrix) {
    for (const cell of row) {
      total = total + cell;
    }
  }
  return total;
}

export function triangleNumber(n: number): number {
  let total: number = 0;
  let i: number = 1;
  while (i <= n) {
    let j: number = 1;
    while (j <= i) {
      total = total + 1;
      j = j + 1;
    }
    i = i + 1;
  }
  return total;
}
