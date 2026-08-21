export function select(values: [number, number, number]): number {
  const [, , third]: [number, number, number] = values;
  return third;
}
