export function charCodeFirst(text: string): number {
  return text.charCodeAt(0);
}

export function isDigitCode(text: string, index: number): boolean {
  const code: number = text.charCodeAt(index);
  return code >= 48 && code <= 57;
}

export function sumCharCodes(text: string): number {
  let total: number = 0;
  for (let i: number = 0; i < text.length; i = i + 1) {
    total = total + text.charCodeAt(i);
  }
  return total;
}
