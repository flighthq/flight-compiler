export function roundDown(value: number): number {
  return Math.floor(value);
}

export function roundUp(value: number): number {
  return Math.ceil(value);
}

export function roundNearest(value: number): number {
  return Math.round(value);
}

export function truncate(value: number): number {
  return Math.trunc(value);
}

export function fractionalPart(value: number): number {
  return value - Math.floor(value);
}
