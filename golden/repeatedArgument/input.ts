export function total(values: readonly number[]): number {
  return values.length;
}

export function report(values: readonly number[]): number {
  return total(values) + total(values);
}

export function eachTotal(rows: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < 2; index += 1) {
    sum += total(rows);
  }
  return sum;
}
