export function findPair(values: number[], target: number): number {
  let found: number = -1;
  for (let i: number = 0; i < values.length; i++) {
    for (let j: number = i + 1; j < values.length; j++) {
      if (values[i]! + values[j]! === target) {
        found = i * 100 + j;
        break;
      }
    }
    if (found >= 0) {
      break;
    }
  }
  return found;
}

export function firstAbove(matrix: number[][], threshold: number): number {
  let result: number = -1;
  for (const row of matrix) {
    for (const cell of row) {
      if (cell > threshold) {
        result = cell;
        break;
      }
    }
    if (result >= 0) {
      break;
    }
  }
  return result;
}
