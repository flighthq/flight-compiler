export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export function formatCoord(x: number, y: number): string {
  return `(${x}, ${y})`;
}

export function wrapTag(tag: string, content: string): string {
  return `<${tag}>${content}</${tag}>`;
}

export function repeatLine(text: string, count: number): string {
  let result: string = '';
  for (let i: number = 0; i < count; i++) {
    result = `${result}${text}\n`;
  }
  return result;
}
