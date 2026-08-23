export enum Level {
  Low = 1,
  High = 2,
}

export interface Named {
  readonly name: string;
}

export interface Tagged extends Named {
  readonly tag: number;
}

export function describe(value: Tagged): string {
  return value.name;
}

export function highest(): Level {
  return Level.High;
}
