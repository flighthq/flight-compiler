type UnionSlot = ((value: number) => void) | string;
type ErasedSlot = ((value: number) => void) | string;
type UnknownSlot = ((value: number) => void) | string;
type PlainSlot = ((value: number) => void) | string;

function takeUnion(value: UnionSlot): number {
  return typeof value === 'string' ? 0 : 1;
}

function takeErased(value: ErasedSlot): number {
  return typeof value === 'string' ? 0 : 1;
}

function takeUnknown(value: UnknownSlot): number {
  return typeof value === 'string' ? 0 : 1;
}

function takePlain(value: PlainSlot): number {
  return typeof value === 'string' ? 0 : 1;
}

// The destination supplies the narrower argument, so the VALUE's own parameter storage is what the call has
// to construct into. An optional OF a variant needs both steps written -- the variant constructs itself from
// the argument and the optional constructs itself from the variant -- which a bare argument does neither of.
export function passUnion(handler: (value: number | string | undefined) => void): number {
  return takeUnion(handler);
}

// A parameter declared `any` -- or `unknown`, which a number is assignable to -- accepts every value the
// source can pass, and the runtime's erased carrier keeps it with its own kind.
export function passErased(handler: (value: any) => void): number {
  return takeErased(handler);
}

export function passUnknown(handler: (value: unknown) => void): number {
  return takeUnknown(handler);
}

// A plain variant constructs itself from the argument, so this one keeps its bare emission: the call passes
// the argument and the carrier does the work. Nothing is cast, copied, or materialized in any of them.
export function passPlain(handler: (value: number | string) => void): number {
  return takePlain(handler);
}
