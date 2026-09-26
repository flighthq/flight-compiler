interface Alpha {
  a: number;
}

interface Beta {
  b: number;
}

interface Gamma {
  c: number;
}

interface Holder {
  slot: Alpha | Beta | Gamma;
}

function take(_value: Alpha | Beta | Gamma): number {
  return 1;
}

// A union holding a subset of the destination's alternatives is a conversion the source language accepts and
// the target can make: every alternative the value can hold is one the destination stores at the same C++
// type, so the conversion is a checked rebuild rather than a gap.
export function pass(value: Alpha | Beta): number {
  return take(value);
}

export function read(value: Alpha | Beta): Alpha | Beta | Gamma {
  return value;
}

export function put(holder: Holder, value: Alpha | Beta): void {
  holder.slot = value;
}
