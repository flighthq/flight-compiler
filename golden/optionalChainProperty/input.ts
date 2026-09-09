export interface Point {
  readonly x: number;
  readonly y: number;
}

export function safe_x(point: Point | null): number {
  return point?.x ?? 0;
}

export function safe_y(point: Point | null): number {
  return point?.y ?? 0;
}

export function safe_sum(point: Point | null): number {
  const x: number = point?.x ?? 0;
  const y: number = point?.y ?? 0;
  return x + y;
}
