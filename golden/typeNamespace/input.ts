export namespace Codes {
  export interface Entry {
    name: string;
    value: number;
  }

  export type Mode = 'fast' | 'safe';
}

export function getDefaultName(): string {
  return 'default';
}

export function getDefaultValue(): number {
  return 0;
}
