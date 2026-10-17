type MutableFlags = boolean[];
type ReadonlyFlags = readonly boolean[];
type MutableNumbers = number[] | undefined;
type ReadonlyNumbers = readonly number[] | undefined;
type MutableLabels = string[];
type ReadonlyLabels = readonly string[];

function makeLabels(): MutableLabels {
  return ['ready'];
}

// Primitive mutable and readonly arrays share one carrier on every target. Rust must move the Vec or
// Option<Vec> exactly once: cloning would silently split the source array's identity.
export function readonlyFlags(values: MutableFlags): ReadonlyFlags {
  return values as ReadonlyFlags;
}

export function readonlyNumbers(values: MutableNumbers): ReadonlyNumbers {
  return values as ReadonlyNumbers;
}

export function readonlyLabels(): ReadonlyLabels {
  return makeLabels() as ReadonlyLabels;
}
