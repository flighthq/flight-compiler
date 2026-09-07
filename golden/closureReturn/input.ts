export function makeAdder(base: number): (x: number) => number {
  return (x: number): number => base + x;
}

export function applyToEach(values: number[], transform: (x: number) => number): number[] {
  return values.map(transform);
}

export function compose(f: (x: number) => number, g: (x: number) => number): (x: number) => number {
  return (x: number): number => f(g(x));
}
