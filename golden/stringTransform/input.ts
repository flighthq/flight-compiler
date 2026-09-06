export function findFirst(text: string, search: string): number {
  return text.indexOf(search);
}

export function findLast(text: string, search: string): number {
  return text.lastIndexOf(search);
}

export function countTokens(text: string, delimiter: string): number {
  const parts: string[] = text.split(delimiter);
  return parts.length;
}

export function splitAndJoin(text: string, delimiter: string, joiner: string): string {
  const parts: string[] = text.split(delimiter);
  return parts.join(joiner);
}
