export function captured_power(base: number): () => number {
  let value: number = base;
  return (): number => {
    value **= 2;
    return value;
  };
}

export function captured_or(initial: number): (fallback: number) => number {
  let value: number = initial;
  return (fallback: number): number => {
    value ||= fallback;
    return value;
  };
}

export function captured_and(initial: number): (replacement: number) => number {
  let value: number = initial;
  return (replacement: number): number => {
    value &&= replacement;
    return value;
  };
}

export function captured_nullish(initial: string | null): (fallback: string) => string {
  let value: string | null = initial;
  return (fallback: string): string => {
    value ??= fallback;
    return value!;
  };
}

export function captured_unsigned_shift(initial: number): (bits: number) => number {
  let value: number = initial;
  return (bits: number): number => {
    value >>>= bits;
    return value;
  };
}

export function captured_bitwise_or(initial: number): (mask: number) => number {
  let value: number = initial;
  return (mask: number): number => {
    value |= mask;
    return value;
  };
}

export function captured_bitwise_and(initial: number): (mask: number) => number {
  let value: number = initial;
  return (mask: number): number => {
    value &= mask;
    return value;
  };
}
