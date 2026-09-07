export function firstAbove(values: number[], threshold: number): number {
  let i: number = 0;
  while (i < values.length) {
    if (values[i]! > threshold) {
      return values[i]!;
    }
    i += 1;
  }
  return -1;
}

export function countOccurrences(text: string, target: string): number {
  let count: number = 0;
  let pos: number = 0;
  while (pos < text.length) {
    if (text.charAt(pos) === target) {
      count += 1;
    }
    pos += 1;
  }
  return count;
}

export function indexOfFirst(values: number[], target: number): number {
  let i: number = 0;
  while (i < values.length) {
    if (values[i]! === target) {
      return i;
    }
    i += 1;
  }
  return -1;
}
