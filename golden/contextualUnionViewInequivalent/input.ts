interface Color {
  readonly r: number;
  readonly g: number;
}

interface Texture {
  readonly id: string;
}

// The two unions name the same two owners, but the source reaches them through a READONLY view. The plan's
// slots match uniquely, so the refusal is not about which alternative is which -- it is that the C++
// carriers differ, and the emitter has no per-slot conversion from a row view to the owner it names.
//
// The runtime side is worth stating precisely, because the refusal's wording ("no checked target-runtime
// conversion exists") reads as a missing contract: `flight::structural_ref_cast<Ref<T>>(row)` DOES recover
// the owner, and it does so without materializing -- `row_materializes_from` requires an EMPTY source object,
// so a view of a real object takes the `wrap_ref(source.shared_object())` branch. What is missing is the
// emitter's per-slot conversion, which is compiler work rather than a runtime contract.
export function pick(value: Readonly<Color> | Readonly<Texture>): Color | Texture {
  return value;
}
