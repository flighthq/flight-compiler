export function total(limit: number): number {
  let sum: number = 0;
  for (let index: number = 0; index < limit; index += 1) {
    sum += index;
  }
  return sum;
}
