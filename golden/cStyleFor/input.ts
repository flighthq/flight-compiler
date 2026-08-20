export function total(values: readonly number[]): number {
  let sum: number = 0;
  for (let index: number = 0; index < values.length; index += 1) {
    sum += values[index] ?? 0;
  }
  return sum;
}
