export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export function formatCoordinate(x: number, y: number): string {
  return `(${x}, ${y})`;
}

export function multiLine(title: string, body: string): string {
  return `Title: ${title}\nBody: ${body}`;
}

export function nested(a: number, b: number): string {
  return `sum=${a + b}, product=${a * b}`;
}
