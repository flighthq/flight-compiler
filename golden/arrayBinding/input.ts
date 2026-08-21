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

export function selectNestedDefault(values: [[number]?]): number {
  const [[first] = [1]]: [[number]?] = values;
  return first;
}

export function selectFixedRest(values: [number, string, boolean]): [string, boolean] {
  const [, ...rest]: [number, string, boolean] = values;
  return rest;
}

export function selectNestedRest(values: [number, string, boolean]): string {
  const [, ...[second]]: [number, string, boolean] = values;
  return second;
}

export function selectOptionalRest(values: [number, string?]): [string?] {
  const [, ...rest]: [number, string?] = values;
  return rest;
}

export function selectMixedRest(values: [number, string, ...boolean[]]): [string, ...boolean[]] {
  const [, ...rest]: [number, string, ...boolean[]] = values;
  return rest;
}

export function selectNestedMixedRest(values: [number, string, ...boolean[]]): boolean[] {
  const [, ...[, ...tail]]: [number, string, ...boolean[]] = values;
  return tail;
}

export function selectRows(rows: Rows<[number, number]>): number {
  for (const [first, second] of rows) {
    return first;
  }
  return 0;
}
type Rows<T> = ReadonlyArray<T>;
