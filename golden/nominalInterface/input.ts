export interface Advancer {
  step: number;
  advance(by: number): number;
}

export class Counter implements Advancer {
  step: number = 1;

  advance(by: number): number {
    return by + this.step;
  }
}
