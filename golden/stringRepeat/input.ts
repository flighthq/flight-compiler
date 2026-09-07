export function repeatString(text: string, count: number): string {
  let result: string = '';
  for (let i: number = 0; i < count; i++) {
    result = result + text;
  }
  return result;
}

export function joinWithSeparator(items: string[], separator: string): string {
  if (items.length === 0) return '';
  let result: string = items[0]!;
  for (let i: number = 1; i < items.length; i++) {
    result = result + separator + items[i]!;
  }
  return result;
}

export function padLeft(text: string, width: number, fill: string): string {
  let result: string = text;
  while (result.length < width) {
    result = fill + result;
  }
  return result;
}

export function surroundWith(text: string, left: string, right: string): string {
  return left + text + right;
}
