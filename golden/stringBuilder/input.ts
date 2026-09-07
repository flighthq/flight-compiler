export function wrapInParens(text: string): string {
  return '(' + text + ')';
}

export function bracket(text: string, left: string, right: string): string {
  return left + text + right;
}

export function buildPath(segments: string[]): string {
  return segments.join('/');
}

export function prefixAll(items: string[], prefix: string): string[] {
  return items.map((item: string): string => prefix + item);
}
