export function has(text: string, search: string): boolean {
  return text.includes(search);
}

export function prefix(text: string): boolean {
  return text.startsWith('hello');
}

export function suffix(text: string): boolean {
  return text.endsWith('world');
}
