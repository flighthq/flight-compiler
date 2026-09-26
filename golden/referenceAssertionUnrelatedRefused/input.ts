interface Named {
  readonly name: string;
}

interface Item extends Named {
  readonly extra: number;
}

// The two records are unrelated in C++: an interface's members flatten into an independent struct, so an
// assertion from a row to the interface it extends has no heritage to cast along, and `static_cast` would
// be a call to a conversion that does not exist. Closing it needs identity the flattened row does not
// carry, so the assertion is refused and named instead of emitted.
export function widen(value: Item): Named {
  return value as Named;
}
