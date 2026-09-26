class BaseShape {
  public id = '';
}

class DerivedShape extends BaseShape {
  public extra = 0;
}

interface Other {
  tag: number;
}

// A class that extends a class is emitted as real C++ inheritance, so the one alternative related to the
// asserted type is reachable by the pointer cast the emitter already performs -- in both directions.
export function narrow(value: BaseShape | Other): DerivedShape {
  return value as DerivedShape;
}

export function widen(value: DerivedShape | Other): BaseShape {
  return value as BaseShape;
}
