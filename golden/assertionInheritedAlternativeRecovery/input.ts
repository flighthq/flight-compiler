class BaseShape {
  public id = '';
}

class DerivedShape extends BaseShape {
  public extra = 0;
}

interface Other {
  tag: number;
}

// The asserted alternative is one the value does not store but inherits from one it does. The branch tests
// which alternative is really present through the variant index, and the held value narrows to the asserted
// class along the same nominal chain -- the class-heritage proof, inside the branch that decided it applies.
export function narrow(value: BaseShape | Other): DerivedShape | undefined {
  return value as DerivedShape | undefined;
}
