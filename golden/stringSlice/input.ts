export function prefix(text: string, count: number): string {
  return text.substring(0, count);
}

export function suffix(text: string, start: number): string {
  return text.substring(start);
}

export function middle(text: string, start: number, end: number): string {
  return text.substring(start, end);
}

export function removeFirst(text: string): string {
  return text.substring(1);
}
