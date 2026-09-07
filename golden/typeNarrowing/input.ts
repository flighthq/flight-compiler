export function describeType(value: string | number): string {
  if (typeof value === 'string') {
    return `string of length ${value.length}`;
  }
  return `number: ${value}`;
}

export function formatValue(value: string | number | boolean): string {
  if (typeof value === 'string') {
    return value.toUpperCase();
  }
  if (typeof value === 'number') {
    return `${value}`;
  }
  return value ? 'yes' : 'no';
}
