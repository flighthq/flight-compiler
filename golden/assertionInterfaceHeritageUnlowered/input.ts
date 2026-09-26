interface BaseShape {
  id: string;
}

interface DerivedShape extends BaseShape {
  extra: number;
}

interface Other {
  tag: number;
}

// Heritage between interfaces is emitted as independent structs that repeat their bases' members, so there
// is no C++ cast between them: the assertion is refused rather than emitted as a cast that cannot compile.
export function narrow(value: BaseShape | Other): DerivedShape {
  return value as DerivedShape;
}
