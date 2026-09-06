export function countWords(text: string): number {
  const trimmed: string = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  const words: string[] = trimmed.split(' ');
  return words.length;
}

export function hasProtocol(url: string): boolean {
  return url.indexOf('://') !== -1;
}

export function containsAt(email: string): boolean {
  return email.indexOf('@') !== -1;
}

export function tokenCount(csv: string): number {
  const tokens: string[] = csv.split(',');
  return tokens.length;
}

export function rejoinTokens(csv: string, separator: string): string {
  const tokens: string[] = csv.split(',');
  return tokens.join(separator);
}
