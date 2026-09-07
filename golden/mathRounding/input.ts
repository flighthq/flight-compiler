export function floorValue(x: number): number {
  return Math.floor(x);
}

export function ceilValue(x: number): number {
  return Math.ceil(x);
}

export function absValue(x: number): number {
  return Math.abs(x);
}

export function roundHalf(x: number): number {
  return Math.floor(x + 0.5);
}

export function clampFloor(value: number, min: number, max: number): number {
  return Math.floor(Math.max(min, Math.min(max, value)));
}

export function distanceFromOrigin(x: number, y: number): number {
  return Math.floor(Math.sqrt(x * x + y * y));
}
