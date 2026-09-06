export function sumMatrix(rows: number, cols: number): number {
  let total: number = 0;
  for (let r: number = 0; r < rows; r++) {
    for (let c: number = 0; c < cols; c++) {
      total += r * cols + c;
    }
  }
  return total;
}

export function classifyRange(value: number): string {
  if (value < 0) {
    return 'negative';
  } else if (value === 0) {
    return 'zero';
  } else if (value < 10) {
    return 'small';
  } else if (value < 100) {
    return 'medium';
  } else {
    return 'large';
  }
}

export function countDivisible(limit: number, divisor: number): number {
  let count: number = 0;
  let i: number = 1;
  while (i <= limit) {
    if (i % divisor === 0) {
      count += 1;
    }
    i += 1;
  }
  return count;
}
