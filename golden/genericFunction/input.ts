export function identity<T>(value: T): T {
  return value;
}

export function firstElement<T>(items: T[]): T {
  return items[0]!;
}

export function pair<A, B>(a: A, b: B): [A, B] {
  return [a, b];
}
