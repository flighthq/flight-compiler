interface Alpha {
  a: number;
  extra: number;
}

interface Beta {
  b: number;
}

function take(_value: Alpha | Beta): number {
  return 1;
}

// The value leaves `a` optional, so it is not the shape Alpha declares and not one Beta accepts either. The
// source language rejects the same call, so the author states the type rather than the target inventing it.
export function pass(value: Partial<Alpha>): number {
  return take(value);
}
