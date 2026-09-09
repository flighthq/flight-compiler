export function assign_string(text: string): string | number {
  let value: string | number = text;
  return value;
}

export function assign_number(n: number): string | number {
  let value: string | number = n;
  return value;
}

export function reassign(flag: boolean): string | number {
  let value: string | number = 'start';
  if (flag) {
    value = 42;
  }
  return value;
}

export function assign_null(text: string | null): string {
  if (text === null) return 'none';
  return text;
}

export function assign_undefined(text: string | undefined): string {
  if (text === undefined) return 'none';
  return text;
}

export function return_member(flag: boolean): string | number {
  if (flag) return 'yes';
  return 0;
}
