class ShapeBase {
  public id = '';
}

class CollisionAabb extends ShapeBase {
  public width = 1;
}

// A reference assertion the target compiler accepts is one between records that are the same type or
// related by CLASS heritage: the emitted C++ inheritance is real, so the converting constructor is real.
// Nothing is cast twice, copied, or materialized.
export function widen(value: CollisionAabb): ShapeBase {
  return value as ShapeBase;
}

interface Named {
  readonly name: string;
}

// The same type spelled through an identity-preserving utility carries no work for the target at all.
export function identity(value: Named): Readonly<Named> {
  return value as Readonly<Named>;
}
