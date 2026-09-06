export class Counter {
  count: number;

  constructor(initial: number) {
    this.count = initial;
  }

  increment(): void {
    this.count = this.count + 1;
  }

  value(): number {
    return this.count;
  }

  static zero(): Counter {
    return new Counter(0);
  }

  static fromValue(value: number): Counter {
    return new Counter(value);
  }
}
