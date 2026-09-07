export function numberToString(value: number): string {
  return `${value}`;
}

export function booleanToString(value: boolean): string {
  return `${value}`;
}

export function concatNumberString(n: number, s: string): string {
  return `${n}` + s;
}

export function formatDecimal(value: number, label: string): string {
  return label + ': ' + `${value}`;
}
