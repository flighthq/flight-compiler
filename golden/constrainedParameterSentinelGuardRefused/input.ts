// A type parameter's sentinel lives in its constraint, and a C++ template parameter is emitted as the type
// argument itself: there is no storage for the sentinel, so the guard over it can neither be folded away
// nor asked. Folding it made `isAbsent(undefined)` answer false for an instantiation the constraint allows;
// the presence test refuses instead, and the declaration is what has to change.
export function isAbsent<T extends string | undefined>(text: T): boolean {
  return text === undefined;
}

export function measure<T extends string | undefined>(text: T): number {
  if (text === undefined) return 0;
  return 1;
}
