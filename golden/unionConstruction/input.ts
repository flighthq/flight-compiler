export function from_call(flag: boolean): string | number {
  const value: string | number = produce(flag);
  return value;
}

export function from_conditional(flag: boolean): string | number {
  const value: string | number = flag ? 'yes' : 0;
  return value;
}

export function from_binary(a: number, b: number): string | number {
  const value: string | number = a + b;
  return value;
}

export function from_unary(n: number): string | number {
  const value: string | number = -n;
  return value;
}

export function from_cast(input: unknown): string | number {
  const value: string | number = input as string;
  return value;
}

function produce(flag: boolean): string {
  return flag ? 'on' : 'off';
}
