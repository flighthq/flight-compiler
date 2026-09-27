interface Point {
  x: number;
}

type NumberSlot = (() => number) | string;
type TextSlot = (() => string) | undefined;
type FlagSlot = (() => boolean) | undefined;
type PointSlot = (() => Point) | undefined;

function takeNumber(value: NumberSlot): number {
  return typeof value === 'string' ? 0 : 1;
}

function takeText(value: TextSlot): number {
  return typeof value === 'undefined' ? 0 : 1;
}

function takeFlag(value: FlagSlot): number {
  return typeof value === 'undefined' ? 0 : 1;
}

function takePoint(value: PointSlot): number {
  return typeof value === 'undefined' ? 0 : 1;
}

// A destination with no absence of its own reads an erased result the same way the optional destinations do,
// without an absence branch: the result must hold exactly the domain the destination declares, read out
// through the runtime's named accessor, and anything else is the promise the source broke. Nothing is cast,
// copied, or materialized.
export function passNumber(handler: () => any): number {
  return takeNumber(handler);
}

export function passText(handler: () => any): number {
  return takeText(handler);
}

export function passFlag(handler: () => any): number {
  return takeFlag(handler);
}

// A reference destination is read through the runtime's exact-type lookup, which answers empty for anything
// else rather than reinterpreting storage.
export function passPoint(handler: () => any): number {
  return takePoint(handler);
}
