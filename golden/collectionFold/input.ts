export function total(values: readonly number[]): number {
  return values.reduce((accumulated, value) => accumulated + value, 0);
}
