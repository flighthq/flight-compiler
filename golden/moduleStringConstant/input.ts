// A literal module string constant is an immutable value. Rust stores it as a &'static str and adapts
// every read into the owned String carrier; the other targets use their own string carriers.
export const GREETING: string = 'hello';
export const TEMPLATE: string = `world`;

const PRIVATE: string = 'secret';

export function direct(): string {
  return GREETING;
}

export function templated(): string {
  return TEMPLATE;
}

export function privateRead(): string {
  return PRIVATE;
}

export function same(name: string): boolean {
  return GREETING === name;
}

export function joined(name: string): string {
  return GREETING + ' ' + name;
}
