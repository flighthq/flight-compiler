interface BaseShape {
  id: string;
}

interface DerivedShape extends BaseShape {
  extra: number;
}

// The same assertion between interfaces: their heritage is emitted as independent structs, so there is no C++
// relationship to cast along and the narrowing refuses rather than emitting a cast that cannot compile.
export function narrow(value: BaseShape | undefined): DerivedShape | undefined {
  return value as DerivedShape | undefined;
}
