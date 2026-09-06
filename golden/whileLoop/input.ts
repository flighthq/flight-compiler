export function countDown(start: number): number {
  let count = start;
  let steps = 0;
  while (count > 0) {
    count = count - 1;
    steps = steps + 1;
  }
  return steps;
}

export function sumUntil(values: readonly number[], limit: number): number {
  let total = 0;
  let index = 0;
  while (index < values.length) {
    if (total + values[index] > limit) {
      break;
    }
    total = total + values[index];
    index = index + 1;
  }
  return total;
}
