export function greetOptional(name?: string): string {
  if (name !== undefined) {
    return `Hello, ${name}!`;
  }
  return 'Hello, stranger!';
}

export function addOptional(a: number, b?: number): number {
  if (b !== undefined) {
    return a + b;
  }
  return a;
}

export function formatOptional(value: number, prefix?: string, suffix?: string): string {
  let result: string = `${value}`;
  if (prefix !== undefined) {
    result = prefix + result;
  }
  if (suffix !== undefined) {
    result = result + suffix;
  }
  return result;
}
