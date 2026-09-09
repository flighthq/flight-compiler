export function narrow_typeof(value: string | number): string {
  if (typeof value === 'string') {
    return value;
  }
  return String(value);
}

export function narrow_typeof_number(value: string | number): number {
  if (typeof value === 'number') {
    return value;
  }
  return 0;
}

export function narrow_branch(value: string | number, flag: boolean): string {
  if (flag && typeof value === 'string') {
    return value;
  }
  return 'default';
}

export function assert_string(value: string | number): string {
  return value as string;
}

export function assert_number(value: string | number): number {
  return value as number;
}
