export function isEqual(a: string, b: string): boolean {
  return a === b;
}

export function isNotEqual(a: string, b: string): boolean {
  return a !== b;
}

export function isEmpty(text: string): boolean {
  return text.length === 0;
}

export function longerThan(text: string, threshold: number): boolean {
  return text.length > threshold;
}

export function matchOrDefault(text: string, expected: string, fallback: string): string {
  if (text === expected) {
    return text;
  }
  return fallback;
}
