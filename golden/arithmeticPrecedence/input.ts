export function addMul(a: number, b: number, c: number): number {
  return a + b * c;
}

export function mulAdd(a: number, b: number, c: number): number {
  return a * b + c;
}

export function groupedAdd(a: number, b: number, c: number): number {
  return (a + b) * c;
}

export function mixedOps(a: number, b: number, c: number, d: number): number {
  return a * b + c / d;
}

export function nestedGroups(a: number, b: number, c: number): number {
  return (a + b) * (b + c);
}
