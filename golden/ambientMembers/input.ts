export function doubled(values: readonly number[]): number[] {
  return values.map((value) => value * 2);
}

export function positives(values: readonly number[]): number[] {
  return values.filter((value) => value > 0);
}

export function shout(text: string): string {
  return text.toUpperCase();
}

export function tidy(text: string): string {
  return text.trim();
}

export function leads(text: string): boolean {
  return text.startsWith('go');
}
