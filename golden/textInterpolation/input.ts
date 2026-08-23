export function label(count: number, name: string): string {
  return `${name} has ${count} items`;
}

export function ratio(numerator: number, denominator: number): string {
  return `${numerator / denominator}`;
}

export function flag(enabled: boolean): string {
  return `${enabled}`;
}

export function joined(first: string, second: string): string {
  return first + second;
}
