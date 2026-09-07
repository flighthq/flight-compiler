export function roundDown(value: number): number {
  return Math.floor(value);
}

export function roundUp(value: number): number {
  return Math.ceil(value);
}

export function rounded(value: number): number {
  return Math.round(value);
}

export function absolute(value: number): number {
  return Math.abs(value);
}

export function integerPart(value: number): number {
  return value >= 0 ? Math.floor(value) : Math.ceil(value);
}
