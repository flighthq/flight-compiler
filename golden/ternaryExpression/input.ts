export function clampValue(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

export function sign(value: number): number {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

export function label(count: number): string {
  return count === 0 ? 'none' : count === 1 ? 'one' : 'many';
}
