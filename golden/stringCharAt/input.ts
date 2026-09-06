export function firstChar(text: string): string {
  return text.charAt(0);
}

export function lastChar(text: string): string {
  return text.charAt(text.length - 1);
}

export function isUpperFirst(text: string): boolean {
  const first: string = text.charAt(0);
  return first === first.toUpperCase();
}
