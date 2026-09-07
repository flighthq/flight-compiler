export function getLength(s: string): number {
  return s.length;
}

export function isEmpty(s: string): boolean {
  return s.length === 0;
}

export function padToLength(s: string, target: number): string {
  let result: string = s;
  while (result.length < target) {
    result = result + ' ';
  }
  return result;
}

export function longerThan(s: string, threshold: number): boolean {
  return s.length > threshold;
}
