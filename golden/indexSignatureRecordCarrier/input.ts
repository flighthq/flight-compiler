type Scalar = boolean | number | string;

// A carrier declaring an index signature admits an open member set, so it is represented as the runtime's
// keyed record rather than as a struct: a read goes through the record's own lookup, a write through its
// setter, and no struct with a fixed member set is emitted for it.
interface Fields {
  [name: string]: Scalar;
}

export function read(fields: Fields, key: string): Scalar | undefined {
  return fields[key];
}

export function write(fields: Fields, key: string, value: Scalar): void {
  fields[key] = value;
}

export function present(fields: Fields, key: string): boolean {
  return fields[key] !== undefined;
}
