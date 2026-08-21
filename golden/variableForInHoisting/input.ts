export interface Values {
  value: number;
}

export function selectFirstKey(values: Values): string {
  for (var key in values) return key;
  return '';
}
