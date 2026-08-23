export abstract class Shape {
  public abstract area(): number;

  public describe(): number {
    return this.area();
  }
}

export class Square extends Shape {
  private side: number;

  public constructor(side: number) {
    super();
    this.side = side;
  }

  public override area(): number {
    return this.side * this.side;
  }
}
