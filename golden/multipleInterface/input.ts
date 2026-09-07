export interface Named {
  readonly name: string;
}

export interface Valued {
  readonly value: number;
}

export function getName(item: Named): string {
  return item.name;
}

export function getValue(item: Valued): number {
  return item.value;
}

export function formatNamed(item: Named): string {
  return 'item: ' + item.name;
}

export function isPositive(item: Valued): boolean {
  return item.value > 0;
}
