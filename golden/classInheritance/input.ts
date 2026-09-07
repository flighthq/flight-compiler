class Base {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
  doubled(): number {
    return this.value * 2;
  }
}

class Child extends Base {
  label: string;
  constructor(value: number, label: string) {
    super(value);
    this.label = label;
  }
  describe(): string {
    return `${this.label}: ${this.doubled()}`;
  }
}

export function createChild(value: number, label: string): string {
  const child: Child = new Child(value, label);
  return child.describe();
}

export function baseDoubled(value: number): number {
  const base: Base = new Base(value);
  return base.doubled();
}
