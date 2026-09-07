export function csvToList(csv: string): string[] {
  return csv.split(',');
}

export function listToCsv(items: string[]): string {
  return items.join(',');
}

export function wordCount(text: string): number {
  const words: string[] = text.split(' ');
  return words.length;
}

export function reverseWords(text: string): string {
  const words: string[] = text.split(' ');
  words.reverse();
  return words.join(' ');
}
