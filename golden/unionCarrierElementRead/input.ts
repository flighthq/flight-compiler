type Scalar = boolean | number | string;

interface Point {
  x: number;
}

interface Fields {
  [name: string]: Scalar;
}

interface Points {
  [name: string]: Point;
}

interface Numbers {
  [name: string]: number;
}

// A union of keyed carriers stores a variant, and no variant has a keyed lookup of its own. The read is a
// projection instead: the visit asks the carrier the value really holds, in that carrier's own key
// domain, and the element lands in the payload the declaration names. An element that is itself a union
// (`Scalar`) is opened by the target's visitor, so it reaches the payload as one of its members rather
// than as a nested variant. Absence is the key's own: a carrier that does not hold the key answers empty.
export function readNumber(fields: Fields | Numbers, key: string): Scalar | number {
  return fields[key];
}

export function readOptional(fields: Fields | Numbers | undefined, key: string): Scalar | number | undefined {
  return fields?.[key];
}

export function readReference(fields: Points | Numbers, key: string): Point | number {
  return fields[key];
}
