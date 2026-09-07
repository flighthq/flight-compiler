export function numberToString(value: number): string {
  return value.toString();
}

export function stringLength(text: string): number {
  return text.length;
}

export function repeatString(text: string, count: number): string {
  let result: string = '';
  for (let i: number = 0; i < count; i = i + 1) {
    result = result + text;
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
