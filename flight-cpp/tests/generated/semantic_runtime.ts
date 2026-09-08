export function summarize(values: number[]): string {
  const indexed = values.map((value, index) => value + index);
  return indexed.join('|');
}

export function update(labels: Map<string, number>, seen: Set<string>): number {
  labels.set('size', labels.size + 1);
  seen.add('size');
  return seen.has('size') ? (labels.get('size') ?? 0) : -1;
}

export function overwrite(values: Uint8Array, source: number[]): number {
  values.set(source);
  return values[0];
}

export function createCounter(initial: number): () => number {
  let value = initial;
  return (): number => {
    value += 1;
    return value;
  };
}

export function observeAfterCreation(): number {
  let value = 0;
  const read = (): number => value;
  value = 7;
  return read();
}

export interface ForInValues {
  value: number;
}

export function selectFirstKey(values: ForInValues): string {
  for (var key in values) return key;
  return '';
}

export async function increment(value: Promise<number>): Promise<number> {
  return (await value) + 1;
}
