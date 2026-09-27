interface Color {
  readonly r: number;
  readonly g: number;
}

interface Texture {
  readonly id: string;
}

// Absence is carried SENTINEL BY SENTINEL where both carriers store it the same way, so which of null and
// undefined the value was survives the conversion instead of collapsing into one of them. The present slot
// is recovered through the runtime's own checked row cast, so the owner keeps its identity: no member is
// copied, no row is materialized, and no native or unchecked cast is written.
export function keepAbsence(
  value: Readonly<Color> | Readonly<Texture> | null | undefined,
): Color | Texture | null | undefined {
  return value;
}

// A source with no absence into a destination that has one: only the present slot is built, and the
// destination's absent states are simply never produced.
export function fromPresent(value: Readonly<Color> | Readonly<Texture>): Color | Texture | null | undefined {
  return value;
}

// An optional carrier stores its union behind `std::optional`, so absence passes as absence and the present
// slot is read through the accessor.
export function fromOptional(value: Readonly<Color> | Readonly<Texture> | undefined): Color | Texture | undefined {
  return value;
}
