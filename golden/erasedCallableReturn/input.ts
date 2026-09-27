type NumberSlot = (() => number | undefined) | string;
type TextSlot = (() => string | undefined) | string;
type ErasedSlot = (() => any) | string;

function takeNumber(value: NumberSlot): number {
  return typeof value === 'string' ? 0 : 1;
}

function takeText(value: TextSlot): number {
  return typeof value === 'string' ? 0 : 1;
}

function takeErased(value: ErasedSlot): number {
  return typeof value === 'string' ? 0 : 1;
}

// The source promised nothing about what it returns and the destination promises a closed result, so the
// adapter writes a checked SELECTION: each alternative the destination can hold is tested for and read out
// through the runtime's named accessor, the destination's absence answers the erased nullish kinds, and a
// value of any other kind breaks the promise the source made and throws. Nothing is reinterpreted, copied,
// or materialized.
export function passNumber(handler: () => any): number {
  return takeNumber(handler);
}

export function passText(handler: () => any): number {
  return takeText(handler);
}

// The control: a source that already declares the erased result is stored as itself, with no extraction.
export function passErased(handler: () => any): number {
  return takeErased(handler);
}
