class BaseShape {
  public id = '';
}

class DerivedShape extends BaseShape {
  public extra = 0;
}

// One value slot, narrowed to a class that derives from it: the target emits real C++ inheritance for that
// pair, so the pointer cast between them is one the target compiler accepts.
export function narrow(value: BaseShape | undefined): DerivedShape | undefined {
  return value as DerivedShape | undefined;
}
