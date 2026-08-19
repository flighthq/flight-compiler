export class Counter {
  private step: number = 1;
  readonly label: string = 'counter';

  advance(by: number): number {
    return by + this.step;
  }
}
