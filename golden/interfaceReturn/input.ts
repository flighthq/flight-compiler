interface Point {
  x: number;
  y: number;
}

export function origin(): Point {
  return { x: 0, y: 0 };
}

export function fromValues(x: number, y: number): Point {
  return { x: x, y: y };
}

export function translate(p: Point, dx: number, dy: number): Point {
  return { x: p.x + dx, y: p.y + dy };
}

export function distance(a: Point, b: Point): number {
  const dx: number = a.x - b.x;
  const dy: number = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
