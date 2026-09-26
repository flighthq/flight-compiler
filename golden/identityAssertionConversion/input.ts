interface Point {
  x: number;
}

// The asserted union and the value's own have one C++ representation: `readonly Point[] | undefined` and
// `Point[] | undefined` are one optional of one array carrier, so the assertion states a source-level
// distinction the target needs no work for. The value is emitted as itself -- nothing is cast, converted,
// or copied, because the two carriers ARE the same type.
export function readonlyView(values: Point[] | undefined): readonly Point[] | undefined {
  return values as readonly Point[] | undefined;
}

export function readonlyNumbers(values: number[] | undefined): readonly number[] | undefined {
  return values as readonly number[] | undefined;
}

// The plain spelling of the same relationship, with no sentinel to move.
export function readonlyPlain(values: Point[]): readonly Point[] {
  return values as readonly Point[];
}
