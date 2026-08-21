export function select(values: [number, number, number]): number {
  const [, , third]: [number, number, number] = values;
  return third;
}

export function selectDefault(values: [number?]): number {
  const [first = 4]: [number?] = values;
  return first;
}

export function selectRest(values: [number, ...number[]]): number[] {
  const [, ...rest]: [number, ...number[]] = values;
  return rest;
}

export function createValues(): [number, number?] {
  const values: [number, number?] = [1];
  return values;
}
