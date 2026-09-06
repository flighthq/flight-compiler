export function createCounter(initial: number): () => number {
  let count = initial;
  return (): number => {
    count = count + 1;
    return count;
  };
}

export function applyTwice(value: number, transform: (x: number) => number): number {
  return transform(transform(value));
}

export function filterAndMap(items: number[], threshold: number): string[] {
  return items.filter((item: number): boolean => item > threshold).map((item: number): string => item.toString());
}
