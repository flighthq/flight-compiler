export function sum(...values: number[]): number {
  let total: number = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

export function counted(...items: readonly number[]): number {
  return items.length;
}
