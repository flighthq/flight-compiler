export function spread(value: number): number {
  return value * value + value + value;
}

export function mirror(text: string): string {
  let result = '';
  for (let i = text.length - 1; i >= 0; i--) {
    result = result + text.charAt(i);
  }
  return text + result;
}

export function clampAndScale(value: number, lo: number, hi: number): number {
  const clamped = value < lo ? lo : value > hi ? hi : value;
  return (clamped - lo) / (hi - lo);
}

export function repeatJoin(text: string, count: number, separator: string): string {
  let result = text;
  for (let i = 1; i < count; i++) {
    result = result + separator + text;
  }
  return result;
}
