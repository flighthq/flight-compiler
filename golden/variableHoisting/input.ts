export function selectNested(): number {
  {
    var value: number = 1;
  }
  return value;
}

export function selectLoop(limit: number): number {
  let total = 0;
  for (var index: number = 0; index < limit; index++) total += index;
  return total + index;
}

export function selectPattern(values: [number, string]): string {
  var [first, second]: [number, string] = values;
  if (first < 0) return '';
  return second;
}

export function incrementValues(values: number[]): void {
  for (var value of values) value += 1;
}
