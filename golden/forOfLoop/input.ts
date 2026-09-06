export function sum(values: number[]): number {
  let total = 0;
  for (const value of values) {
    total = total + value;
  }
  return total;
}

export function collect(items: string[]): string {
  let result = '';
  for (const item of items) {
    result = result + item;
  }
  return result;
}
