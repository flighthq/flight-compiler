export class Rectangle {
  public width: number;
  public height: number;

  public constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  public area(): number {
    return this.width * this.height;
  }

  public perimeter(): number {
    return 2 * (this.width + this.height);
  }

  public isSquare(): boolean {
    return this.width === this.height;
  }

  public scale(factor: number): Rectangle {
    return new Rectangle(this.width * factor, this.height * factor);
  }
}

export function totalArea(rects: Rectangle[]): number {
  let sum: number = 0;
  for (const rect of rects) {
    sum = sum + rect.area();
  }
  return sum;
}
