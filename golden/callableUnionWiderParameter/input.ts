interface Point {
  x: number;
}

type NumberOrText = number | string;
type HandlerSlot = ((value: number) => void) | string;

// The destination supplies a number, and a number is one member of what the value accepts. The variant
// the source stores constructs itself from the argument the destination's own signature names, which is
// the same call the source would receive for a value of that member's type -- so the callable is stored
// through an adapter that passes the argument along, with no cast and nothing copied but the callable.
export function storeWider(handler: (value: number | string) => void): HandlerSlot {
  return handler;
}

export function storeAlias(handler: (value: NumberOrText) => void): HandlerSlot {
  return handler;
}

export function storeThreeMember(handler: (value: number | string | boolean) => void): HandlerSlot {
  return handler;
}

// A union carrying its own sentinels stores a variant of every alternative, so a present value is still
// one the variant constructs itself from.
export function storeSentinels(handler: (value: number | string | null | undefined) => void): HandlerSlot {
  return handler;
}

type PointSlot = ((value: Point) => void) | string;

// The member the destination supplies is a reference, and the variant names that reference among its
// alternatives -- the same conversion, one alternative further in.
export function storeReference(handler: (value: string | Point) => void): PointSlot {
  return handler;
}
