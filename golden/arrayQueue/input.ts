export function dequeue(items: number[]): number {
  return items.shift()!;
}

export function enqueue(items: number[], value: number): void {
  items.push(value);
}

export function prepend(items: string[], value: string): void {
  items.unshift(value);
}

export function rotateFirst(items: number[]): void {
  const first: number = items.shift()!;
  items.push(first);
}
