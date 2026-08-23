export interface Entry {
  readonly key: string;
  readonly value: number;
}

export function appended(entries: readonly Entry[], key: string, value: number): Entry[] {
  const next = entries.slice();
  next.push({ key, value });
  return next;
}

export function tailSize(entries: readonly Entry[], index: number): number {
  return entries.slice(index).length;
}
