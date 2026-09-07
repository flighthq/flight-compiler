export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly origin: Point;
  readonly size: Point;
}

export function area(rect: Rect): number {
  return rect.size.x * rect.size.y;
}

export function translate(rect: Rect, dx: number, dy: number): Rect {
  return {
    origin: { x: rect.origin.x + dx, y: rect.origin.y + dy },
    size: rect.size,
  };
}

export function diagonal(rect: Rect): number {
  const w: number = rect.size.x;
  const h: number = rect.size.y;
  return Math.sqrt(w * w + h * h);
}
