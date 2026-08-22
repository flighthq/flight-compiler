export function isEmpty(values: readonly number[]): boolean {
  return values.length < 1;
}

export function widthOf(shape: { width: number; height: number }): number {
  return shape.width * shape.height;
}
