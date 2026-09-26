type Scalar = boolean | number | string;

interface Fields {
  [name: string]: Scalar;
}

interface Counts {
  [index: number]: number;
}

// A declared index-signature carrier is the runtime's keyed record, and the carrier's own lookup already
// answers absence: the optional chain adds only the receiver's sentinel, so a missing receiver and a
// missing key are the same `undefined` in the result. This is the shape that previously refused -- it
// reached the element lane with no collection carrier, because the representation planner does not
// categorize this program's own declaration the way it categorizes the runtime's `Record`.
export function readField(fields: Fields | undefined, key: string): Scalar | undefined {
  return fields?.[key];
}

export function readCount(counts: Counts | undefined, index: number): number | undefined {
  return counts?.[index];
}

export function readAmbient(values: Record<string, number> | undefined, key: string): number | undefined {
  return values?.[key];
}

export function readArray(values: number[] | undefined, index: number): number | undefined {
  return values?.[index];
}
