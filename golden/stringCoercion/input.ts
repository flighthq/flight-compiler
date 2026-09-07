export function numberToString(value: number): string {
  return String(value);
}

export function booleanToString(value: boolean): string {
  return String(value);
}

export function concatNumberString(n: number, s: string): string {
  return String(n) + s;
}

export function formatDecimal(value: number, label: string): string {
  return label + ': ' + String(value);
}
