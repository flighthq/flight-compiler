export function reverse(text: string): string {
  let result: string = '';
  for (let i: number = text.length - 1; i >= 0; i--) {
    result = result + text.charAt(i);
  }
  return result;
}

export function countChar(text: string, ch: string): number {
  let count: number = 0;
  for (let i: number = 0; i < text.length; i++) {
    if (text.charAt(i) === ch) {
      count = count + 1;
    }
  }
  return count;
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}
