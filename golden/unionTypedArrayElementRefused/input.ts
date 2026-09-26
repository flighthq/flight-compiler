// A typed array leaves its element type to the runtime's template argument, so the IR records no element
// payload a projection could name for it. Mixing one into a union keeps the read refused rather than
// asking the compiler to guess which slot the element belongs in.
export function read(values: number[] | Uint8Array | undefined, index: number): number | undefined {
  return values?.[index];
}
