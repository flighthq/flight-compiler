interface Point {
  x: number;
}

// An element read through a union of arrays asks each alternative for the index and places the element in
// the payload the declaration names: only the branch naming the array the value really holds runs, and no
// subscript reaches the variant. The optional spelling adds the receiver's own sentinel, so a missing
// receiver and an index the array does not hold are the same `undefined` in the result.
export function readOptional(values: number[] | string[] | undefined, index: number): number | string | undefined {
  return values?.[index];
}

export function readReference(values: Point[] | number[] | undefined, index: number): Point | number | undefined {
  return values?.[index];
}

// The plain read is the same question without the receiver's sentinel.
export function readPlain(values: number[] | string[], index: number): number | string {
  return values[index];
}
