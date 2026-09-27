class ShapeBase {
  public id = '';
}

class CollisionAabb extends ShapeBase {
  public width = 1;
}

// A reference assertion between records related by CLASS heritage is a pointer cast, not a value
// conversion: the emitted C++ inheritance is real, so the runtime's own pointer cast is exactly the
// conversion that relation proves -- and it is the same form for both directions, because the converting
// constructor only goes from derived to base. Nothing is copied or materialized.
export function widen(value: CollisionAabb): ShapeBase {
  return value as ShapeBase;
}

export function narrow(value: ShapeBase): CollisionAabb {
  return value as CollisionAabb;
}

interface Named {
  readonly name: string;
}

// The same type spelled through an identity-preserving utility carries no work for the target at all.
export function identity(value: Named): Readonly<Named> {
  return value as Readonly<Named>;
}
