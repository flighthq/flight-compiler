export function or_assign(a: number, b: number): number {
  let value: number = a;
  value ||= b;
  return value;
}

export function and_assign(a: number, b: number): number {
  let value: number = a;
  value &&= b;
  return value;
}

export function nullish_assign(a: string | null, fallback: string): string {
  let value: string | null = a;
  value ??= fallback;
  return value;
}

export function or_assign_expr(a: number, b: number): number {
  let value: number = a;
  const result: number = (value ||= b);
  return result;
}

export function and_assign_expr(a: number, b: number): number {
  let value: number = a;
  const result: number = (value &&= b);
  return result;
}

export function nullish_assign_expr(a: string | null, fallback: string): string {
  let value: string | null = a;
  const result: string = (value ??= fallback);
  return result;
}
