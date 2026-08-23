export class Counter {
  private count: number;
  public static readonly zero: number = 0;

  public constructor(count: number) {
    this.count = count;
  }

  public get value(): number {
    return this.count;
  }

  public set value(next: number) {
    this.count = next;
  }

  public static make(): Counter {
    return new Counter(0);
  }
}

export function readBack(): number {
  const counter = Counter.make();
  counter.value = 7;
  return counter.value + Counter.zero;
}
