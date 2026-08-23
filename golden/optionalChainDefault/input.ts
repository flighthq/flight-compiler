export interface Entry {
  readonly key: string;
}

export function firstKey(entries: readonly Entry[]): string {
  return entries[0]?.key ?? 'none';
}
