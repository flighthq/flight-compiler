export function contains(entries: Map<string, number>, key: string): boolean {
  return entries.has(key);
}

export function count(entries: Map<string, number>): number {
  return entries.size;
}

export function insert(entries: Map<string, number>, key: string, value: number): void {
  entries.set(key, value);
}

export function remove(entries: Map<string, number>, key: string): boolean {
  return entries.delete(key);
}

export function setContains(values: Set<string>, item: string): boolean {
  return values.has(item);
}

export function setSize(values: Set<string>): number {
  return values.size;
}

export function setAdd(values: Set<string>, item: string): void {
  values.add(item);
}
