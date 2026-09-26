interface Alpha {
  a: number;
}

interface Beta {
  b: number;
}

interface Gamma {
  c: number;
}

// The assertion names the one alternative it claims is active. Which one is active at runtime is what the
// `get_if` per alternative answers, so a value holding another alternative throws rather than becoming one
// it is not, and absence crosses wherever the assertion admits it.
export function one(value: Alpha | Beta | Gamma): Alpha | undefined {
  return value as Alpha | undefined;
}

export function nullable(value: Alpha | Beta): Alpha | null {
  return value as Alpha | null;
}

export function fromNullable(value: (Alpha | Beta) | undefined): Alpha | undefined {
  return value as Alpha | undefined;
}
