interface Color {
  readonly r: number;
  readonly g: number;
}

interface Texture {
  readonly id: string;
}

// A readonly view of an owner is converted to the owner by the runtime's OWN checked recovery: the row's
// object is the same object, so the value keeps its identity and no member is copied, no row is materialized,
// and no native cast is written. The proof is per slot -- each source row must name exactly the owner one
// destination slot's runtime type is -- and a source that fails any pairing keeps the refusal.
export function pick(value: Readonly<Color> | Readonly<Texture>): Color | Texture {
  return value;
}
