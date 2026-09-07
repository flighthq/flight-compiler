export function trimLower(text: string): string {
  return text.trim().toLowerCase();
}

export function trimUpper(text: string): string {
  return text.trim().toUpperCase();
}

export function measureTrimmed(text: string): number {
  return text.trim().length;
}

export function lowerLength(text: string): number {
  return text.toLowerCase().length;
}
