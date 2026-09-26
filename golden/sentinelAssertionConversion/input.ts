type Slot = string | number;

interface Point {
  x: number;
}

type PointSlot = Point | number;

// The assertion names the value's own alternatives and moves the absence marker rather than narrowing one
// of them. Claiming presence unwraps the carrier's optional and throws if an absence reaches it, which is
// the same checked selection the alternative narrowings make; asserting the presence the value already has
// wraps it, and nothing is invented. No alternative is converted, nothing is copied, and no cast is made.
export function present(value: Slot | undefined): Slot {
  return value as Slot;
}

export function widen(value: Slot): Slot | undefined {
  return value as Slot | undefined;
}

export function presentRecord(value: PointSlot | undefined): PointSlot {
  return value as PointSlot;
}
