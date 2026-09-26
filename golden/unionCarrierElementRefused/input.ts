type Scalar = boolean | number | string;

interface Fields {
  [name: string]: Scalar;
}

interface Other {
  [name: string]: number;
}

// A union of keyed carriers stores a variant, and no variant has a keyed lookup of its own: the read
// needs a projection per alternative. It is refused and named rather than emitted as a subscript on the
// variant -- the alternative type's operator, on a value the variant does not have.
export function read(fields: Fields | Other, key: string): Scalar | number | undefined {
  return fields[key];
}
