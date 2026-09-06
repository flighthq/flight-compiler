export function greetUser(name: string): string {
  return 'Hello, ' + name + '!';
}

export function formatPair(key: string, value: number): string {
  return key + '=' + value.toString();
}

export function repeat(text: string, count: number): string {
  let result: string = '';
  for (let i: number = 0; i < count; i++) {
    result += text;
  }
  return result;
}
