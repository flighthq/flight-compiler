export function describe(value: string | number): string {
  if (typeof value === 'string') {
    return value.toUpperCase();
  }
  return `number ${value}`;
}

export function length(value: string | number): number {
  if (typeof value === 'number') {
    return 1;
  }
  return value.length;
}

export function classify(value: string | number | boolean): string {
  if (typeof value === 'string') {
    return 'text';
  }
  if (typeof value === 'number') {
    return 'count';
  }
  return 'flag';
}
