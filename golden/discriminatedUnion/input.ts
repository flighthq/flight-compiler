export interface Circle {
  readonly kind: 'circle';
  readonly radius: number;
}

export interface Square {
  readonly kind: 'square';
  readonly side: number;
}

export type Shape = Circle | Square;

export function area(shape: Shape): number {
  if (shape.kind === 'circle') {
    return shape.radius * shape.radius * 3;
  }
  return shape.side * shape.side;
}
