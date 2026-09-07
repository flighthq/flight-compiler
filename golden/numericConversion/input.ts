export function clampValue(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

export function roundToPlaces(value: number, places: number): number {
  const factor: number = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

export function average(values: number[]): number {
  const count: number = values.length;
  if (count === 0) return 0;
  let sum: number = 0;
  for (const value of values) {
    sum = sum + value;
  }
  return sum / count;
}
