export class Counter {
  total: number;
  step: number;

  read(): number {
    return this.total;
  }

  scaled(factor: number): number {
    return this.total * factor;
  }

  advance(): void {
    this.total = this.total + this.step;
  }
}
