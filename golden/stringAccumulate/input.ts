export function join(parts: string[], separator: string): string {
  if (parts.length === 0) return '';
  let result = parts[0]!;
  for (let i = 1; i < parts.length; i++) {
    result = result + separator + parts[i]!;
  }
  return result;
}

export function repeat(text: string, count: number): string {
  let result = '';
  for (let i = 0; i < count; i++) {
    result = result + text;
  }
  return result;
}

export function wrap(text: string, before: string, after: string): string {
  return before + text + after;
}

export function padLeft(text: string, width: number, fill: string): string {
  let result = text;
  while (result.length < width) {
    result = fill + result;
  }
  return result;
}
