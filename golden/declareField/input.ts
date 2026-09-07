export class Config {
  declare label: string;
  declare readonly flags: number;
  value: number = 0;

  public getLabel(): string {
    return this.label;
  }

  public getFlags(): number {
    return this.flags;
  }

  public getValue(): number {
    return this.value;
  }
}
