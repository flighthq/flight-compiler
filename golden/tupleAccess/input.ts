export function first(pair: [number, string]): number {
  return pair[0];
}

export function second(pair: [number, string]): string {
  return pair[1];
}

export function swap(pair: [number, string]): [string, number] {
  return [pair[1], pair[0]];
}

export function sum_pair(pair: [number, number]): number {
  return pair[0] + pair[1];
}
