interface Alpha {
  a: number;
}

interface Beta {
  b: number;
}

interface Gamma {
  c: number;
}

// The asserted union is a subset of what the value holds, so the narrowing is of the CARRIER: which
// alternative is active is a runtime question, answered with `get_if`, and the copy between the two
// carriers is exact because a target slot names the same C++ type the source stores.
export function read(value: Alpha | Beta | Gamma): Alpha | Beta {
  return value as Alpha | Beta;
}

export function nullable(value: (Alpha | Beta | Gamma) | undefined): (Alpha | Beta) | undefined {
  return value as (Alpha | Beta) | undefined;
}

export function present(value: (Alpha | Beta | Gamma) | undefined): Alpha | Beta {
  return value as Alpha | Beta;
}

export function overlapping(value: Alpha | Beta): Alpha | Gamma {
  return value as Alpha | Gamma;
}
