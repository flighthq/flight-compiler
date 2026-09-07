export function trimAndLower(text: string): string {
  return text.trim().toLowerCase();
}

export function isPalindrome(text: string): boolean {
  const lower: string = text.toLowerCase();
  const len: number = lower.length;
  let i: number = 0;
  while (i < len / 2) {
    if (lower.charAt(i) !== lower.charAt(len - 1 - i)) return false;
    i = i + 1;
  }
  return true;
}

export function hasPrefix(text: string, prefix: string): boolean {
  return text.startsWith(prefix) && text.length > prefix.length;
}

export function replaceFirst(text: string, from: string, to: string): string {
  return text.replace(from, to);
}
