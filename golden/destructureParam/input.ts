export interface Rectangle {
  readonly height: number;
  readonly width: number;
}

export function area({ width, height }: Rectangle): number {
  return width * height;
}

export function perimeter({ width, height }: Rectangle): number {
  return 2 * (width + height);
}

export function diagonal({ width, height }: Rectangle): number {
  return Math.sqrt(width * width + height * height);
}

export function isSquare({ width, height }: Rectangle): boolean {
  return width === height;
}
