export class Point {
  public x: number;
  public y: number;
  public constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  public length(): number {
    return this.x + this.y;
  }
  public describe(): string {
    return `point ${this.x}, ${this.y}`;
  }
  public bare(): string {
    return `${this.x}`;
  }
}

export function origin(): Point {
  return new Point(0, 0);
}

export function originLength(): number {
  return origin().length();
}

export function describedAt(x: number, y: number): string {
  return new Point(x, y).describe();
}
