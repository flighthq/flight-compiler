interface Point {
  x: number;
}

interface Box<Value> {
  value: Value;
}

type PointAlias = Point;

type ArraySlot = readonly PointAlias[] | number;
type MapSlot = Map<string, PointAlias> | boolean;
type CallableSlot = (() => PointAlias) | string;
type GenericSlot = Box<PointAlias> | number;

// A declared alias is emitted as a C++ `using`, so an alternative that reaches a type through a name and a
// value that spells the name's target are one type -- one spelling is simply not the other. Each position
// below puts the alias somewhere inside the alternative: an array element, a map argument, a callable
// signature, and another declaration's type argument. The value stores through the alternative's own
// carrier, with no cast and no materialization.
export function storeArray(values: readonly Point[]): ArraySlot {
  return values;
}

export function storeMap(values: Map<string, Point>): MapSlot {
  return values;
}

export function storeCallable(handler: () => Point): CallableSlot {
  return handler;
}

export function storeGeneric(box: Box<Point>): GenericSlot {
  return box;
}
