export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  origin: Point;
  size: Point;
}

export function area(rect: Rect): number {
  return rect.size.x * rect.size.y;
}

export function translate(rect: Rect, dx: number, dy: number): Point {
  return { x: rect.origin.x + dx, y: rect.origin.y + dy };
}

export function diagonal(rect: Rect): number {
  const w: number = rect.size.x;
  const h: number = rect.size.y;
  return Math.sqrt(w * w + h * h);
}
